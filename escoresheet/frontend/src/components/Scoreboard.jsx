import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import Modal from './Modal'
import GuideModal from './GuideModal'
import ConnectionStatus from './ConnectionStatus'
import MenuList from './MenuList'
import { useSyncQueue } from '../hooks/useSyncQueue'
import SignaturePad from './SignaturePad'
import mikasaVolleyball from '../mikasa_v200w.png'

export default function Scoreboard({ matchId, onFinishSet, onOpenSetup, onOpenMatchSetup, onOpenCoinToss }) {
  const { syncStatus } = useSyncQueue()
  const [now, setNow] = useState(() => new Date())
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )
  const [duplicateTabError, setDuplicateTabError] = useState(false)
  const tabIdRef = useRef(Math.random().toString(36).substring(2, 15))
  const [showLogs, setShowLogs] = useState(false)
  const [logSearchQuery, setLogSearchQuery] = useState('')
  const [showManualPanel, setShowManualPanel] = useState(false)
  const [showRemarks, setShowRemarks] = useState(false)
  const [remarksText, setRemarksText] = useState('')
  const remarksTextareaRef = useRef(null)
  const [showRosters, setShowRosters] = useState(false)
  const [showSanctions, setShowSanctions] = useState(false)
  const [menuModal, setMenuModal] = useState(false)
  const [showOptionsInMenu, setShowOptionsInMenu] = useState(false)
  const [localManageCaptainOnCourt, setLocalManageCaptainOnCourt] = useState(() => {
    // Load from localStorage, default to false
    const saved = localStorage.getItem('manageCaptainOnCourt')
    return saved === 'true'
  })
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
  // Display mode: 'desktop' | 'tablet' | 'smartphone' | 'auto'
  const [displayMode, setDisplayMode] = useState(() => {
    const saved = localStorage.getItem('displayMode')
    return saved || 'auto' // default to auto-detect
  })
  const [detectedDisplayMode, setDetectedDisplayMode] = useState('desktop') // What mode was auto-detected
  const [displayModeSuggestion, setDisplayModeSuggestion] = useState(null) // null | 'tablet' | 'smartphone'
  const [showDisplayModeSuggestion, setShowDisplayModeSuggestion] = useState(false)
  const [leftTeamSanctionsExpanded, setLeftTeamSanctionsExpanded] = useState(false)
  const [rightTeamSanctionsExpanded, setRightTeamSanctionsExpanded] = useState(false)
  const [leftTeamBenchExpanded, setLeftTeamBenchExpanded] = useState(false)
  const [rightTeamBenchExpanded, setRightTeamBenchExpanded] = useState(false)
  const [accidentalRallyConfirmModal, setAccidentalRallyConfirmModal] = useState(null) // { onConfirm: function } | null
  const [accidentalPointConfirmModal, setAccidentalPointConfirmModal] = useState(null) // { team: 'home'|'away', onConfirm: function } | null
  const lastPointAwardedTimeRef = useRef(null) // Track when last point was awarded
  const rallyStartTimeRef = useRef(null) // Track when rally started
  const [keybindingsEnabled, setKeybindingsEnabled] = useState(() => {
    const saved = localStorage.getItem('keybindingsEnabled')
    return saved === 'true' // default false
  })
  const [keybindingsModalOpen, setKeybindingsModalOpen] = useState(false)
  const defaultKeyBindings = {
    pointLeft: 'a',
    pointRight: 'l',
    timeoutLeft: 'q',
    timeoutRight: 'p',
    exchangeLiberoLeft: 'x',
    exchangeLiberoRight: 'n',
    undo: 'Backspace',
    confirm: 'Enter',
    cancel: 'Escape',
    startRally: 'Enter'
  }
  const [keyBindings, setKeyBindings] = useState(() => {
    const saved = localStorage.getItem('keyBindings')
    if (saved) {
      try {
        return { ...defaultKeyBindings, ...JSON.parse(saved) }
      } catch {
        return defaultKeyBindings
      }
    }
    return defaultKeyBindings
  })
  const [editingKey, setEditingKey] = useState(null) // Which key binding is being edited
  const [scoreboardGuideModal, setScoreboardGuideModal] = useState(false)
  const [serverRunning, setServerRunning] = useState(false)
  const [serverStatus, setServerStatus] = useState(null)
  const [serverLoading, setServerLoading] = useState(false)
  const [editPinModal, setEditPinModal] = useState(false)
  const [showPinsModal, setShowPinsModal] = useState(false)
  const [newPin, setNewPin] = useState('')
  const [pinError, setPinError] = useState('')
  const [editPinType, setEditPinType] = useState(null) // 'referee' | 'teamA' | 'teamB'
  const [connectionModal, setConnectionModal] = useState(null) // 'referee' | 'teamA' | 'teamB' | null
  const [connectionModalPosition, setConnectionModalPosition] = useState({ x: 0, y: 0 })
  const [courtSwitchModal, setCourtSwitchModal] = useState(null) // { set, homePoints, awayPoints, teamThatScored } | null
  const [timeoutModal, setTimeoutModal] = useState(null) // { team: 'home'|'away', countdown: number, started: boolean }
  const [betweenSetsCountdown, setBetweenSetsCountdown] = useState(null) // { countdown: number, started: boolean, finished?: boolean } | null
  const countdownDismissedRef = useRef(false) // Track if countdown was manually dismissed
  const [lineupModal, setLineupModal] = useState(null) // { team: 'home'|'away', mode?: 'initial'|'manual' } | null
  const [scoresheetErrorModal, setScoresheetErrorModal] = useState(null) // { error: string, details?: string } | null
  const [exceptionalSubstitutionModal, setExceptionalSubstitutionModal] = useState(null) // { team: 'home'|'away', position: string, playerOut: number, reason: 'expulsion'|'disqualification'|'injury' } | null
  const [substitutionDropdown, setSubstitutionDropdown] = useState(null) // { team: 'home'|'away', position: 'I'|'II'|'III'|'IV'|'V'|'VI', playerNumber: number, element: HTMLElement, isInjury?: boolean } | null
  const [substitutionConfirm, setSubstitutionConfirm] = useState(null) // { team: 'home'|'away', position: 'I'|'II'|'III'|'IV'|'V'|'VI', playerOut: number, playerIn: number, isInjury?: boolean, isExceptional?: boolean, isExpelled?: boolean, isDisqualified?: boolean } | null
  const [liberoDropdown, setLiberoDropdown] = useState(null) // { team: 'home'|'away', position: 'I'|'V'|'VI', playerNumber: number, element: HTMLElement } | null
  const [liberoConfirm, setLiberoConfirm] = useState(null) // { team: 'home'|'away', position: 'I'|'V'|'VI', playerOut: number, liberoIn: string } | null
  const [liberoInDropdown, setLiberoInDropdown] = useState(null) // { team: 'home'|'away', side: 'left'|'right', element: HTMLElement, x?: number, y?: number } | null
  const [undoConfirm, setUndoConfirm] = useState(null) // { event: Event, description: string } | null
  const [liberoReminder, setLiberoReminder] = useState(null) // { teams: ['home'|'away'] } | null - Show reminder at start of set
  const [liberoRotationModal, setLiberoRotationModal] = useState(null) // { team: 'home'|'away', position: 'IV', liberoNumber: number, playerNumber: number } | null
  const [exchangeLiberoDropdown, setExchangeLiberoDropdown] = useState(null) // { team: 'home'|'away', position: 'I'|'V'|'VI', liberoNumber: number, element: HTMLElement } | null
  const [liberoReentryModal, setLiberoReentryModal] = useState(null) // { team: 'home'|'away', position: 'I', playerNumber: number, liberoNumber: number, liberoType: string, availableLiberos: [{number, type, label}], selectedLiberoIndex: number } | null
  const [liberoRedesignationModal, setLiberoRedesignationModal] = useState(null) // { team: 'home'|'away', unableLiberoNumber: number, unableLiberoType: string } | null
  const [liberoUnableModal, setLiberoUnableModal] = useState(null) // { team: 'home'|'away', liberoNumber: number, liberoType: string } | null
  const [liberoBenchActionMenu, setLiberoBenchActionMenu] = useState(null) // { team: 'home'|'away', liberoNumber: number, liberoType: string, element: HTMLElement, x: number, y: number } | null
  const [captainOnCourtModal, setCaptainOnCourtModal] = useState(null) // { team: 'home'|'away' } | null
  const [reopenSetConfirm, setReopenSetConfirm] = useState(null) // { setId: number, setIndex: number } | null
  const [setStartTimeModal, setSetStartTimeModal] = useState(null) // { setIndex: number, defaultTime: string } | null
  const [setEndTimeModal, setSetEndTimeModal] = useState(null) // { setIndex: number, winner: string, homePoints: number, awayPoints: number, defaultTime: string } | null
  const [set5SideServiceModal, setSet5SideServiceModal] = useState(null) // { setIndex: number, set4LeftTeamLabel: string, set4RightTeamLabel: string, set4ServingTeamLabel: string } | null - shown after set 4 ends
  const [set5SelectedLeftTeam, setSet5SelectedLeftTeam] = useState('A')
  const [set5SelectedFirstServe, setSet5SelectedFirstServe] = useState('A')
  const [postMatchSignature, setPostMatchSignature] = useState(null) // 'home-captain' | 'away-captain' | null
  const [sanctionConfirm, setSanctionConfirm] = useState(null) // { side: 'left'|'right', type: 'improper_request'|'delay_warning'|'delay_penalty' } | null
  const [sanctionDropdown, setSanctionDropdown] = useState(null) // { team: 'home'|'away', type: 'player'|'bench'|'libero'|'official', playerNumber?: number, position?: string, role?: string, element: HTMLElement, x?: number, y?: number } | null
  const [sanctionConfirmModal, setSanctionConfirmModal] = useState(null) // { team: 'home'|'away', type: 'player'|'bench'|'libero'|'official', playerNumber?: number, position?: string, role?: string, sanctionType: 'warning'|'penalty'|'expulsion'|'disqualification' } | null
  const [injuryDropdown, setInjuryDropdown] = useState(null) // { team: 'home'|'away', position: 'I'|'II'|'III'|'IV'|'V'|'VI', playerNumber: number, element: HTMLElement, x?: number, y?: number } | null
  const [playerActionMenu, setPlayerActionMenu] = useState(null) // { team: 'home'|'away', position: 'I'|'II'|'III'|'IV'|'V'|'VI', playerNumber: number, element: HTMLElement, x?: number, y?: number, canSubstitute: boolean, canEnterLibero: boolean } | null
  const [benchPlayerActionMenu, setBenchPlayerActionMenu] = useState(null) // { team: 'home'|'away', playerNumber: number, element: HTMLElement, x?: number, y?: number, canSubstitute: boolean, courtPlayerToSwapWith?: { number: number, position: string } } | null
  const [benchSubExpanded, setBenchSubExpanded] = useState(false) // Track if substitution list is expanded in bench player menu
  const [courtSubExpanded, setCourtSubExpanded] = useState(false) // Track if substitution list is expanded in court player menu
  const [courtSanctionExpanded, setCourtSanctionExpanded] = useState(false) // Track if sanction list is expanded in court player menu
  const [benchSanctionExpanded, setBenchSanctionExpanded] = useState(false) // Track if sanction list is expanded in bench player menu
  const [toSubDetailsModal, setToSubDetailsModal] = useState(null) // { type: 'timeout'|'substitution', side: 'left'|'right' } | null
  const [showHelpModal, setShowHelpModal] = useState(false)
  const [selectedHelpTopic, setSelectedHelpTopic] = useState(null)
  const [replayRallyConfirm, setReplayRallyConfirm] = useState(null) // { event: Event, description: string } | null
  const wsRef = useRef(null) // Store WebSocket connection for use in callbacks
  const previousMatchIdRef = useRef(null) // Track previous matchId to detect changes
  const wakeLockRef = useRef(null) // Wake lock to prevent screen sleep
  const syncFunctionRef = useRef(null) // Store sync function for use in action handlers
  const noSleepVideoRef = useRef(null) // Video element for NoSleep fallback

  // Request wake lock to prevent screen from sleeping
  useEffect(() => {
    // Create a tiny looping video that keeps the screen awake on mobile/tablets
    const createNoSleepVideo = () => {
      if (noSleepVideoRef.current) return
      
      // Base64 encoded tiny MP4 video (blank, silent, loops)
      const mp4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAA1VtZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE1NSByMjkxNyAwYTg0ZDk4IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAxOCAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTMgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAbWWIhAAz//727L4FNf2f0JcRLMXaSnA+KqSAgHc0wAAAAwAAAwAAV/8iZ2P/4kTVAAIgAAABHQZ4iRPCv/wAAAwAAAwAAHxQSRJ2C2E0AAAMAAAMAYOLkAADAAAHPgVxpAAKGAAABvBqIAg5LAH4AABLNAAAAHEGeQniFfwAAAwAAAwACNQsIAADAAADABOvIgAAAABoBnmF0Rn8AAAMAAAMAAApFAADAAADAECGAAHUAAAAaAZ5jakZ/AAADAAADAAClYlVkAAADAAADAJdwAAAAVUGaZkmoQWyZTAhv//6qVQAAAwAACjIWAANXJ5AAVKLiPqsAAHG/pAALrZ6AAHUhqAAC8QOAAHo0KAAHqwIAAeNf4AAcfgdSAAGdg+sAAOCnAABH6AAAADdBnoRFESwn/wAAAwAAAwAB7YZ+YfJAAOwAkxZiAgABmtQACVrdYAAbcqMAAPMrOAAH1LsAAJ5gAAAAGgGeo3RGfwAAAwAAAwAAXHMAADAAADAEfmAAdQAAABoBnqVqRn8AAAMAAAMAAKReyQADAAADABYxgAAAAFVBmqpJqEFsmUwIb//+qlUAAAMAAAoWMAANXIYAAUZC4kLQAB8rCgABTxKAADq86AAFHAwAAe3E4AAdTHoAAahnMAAL7zYAAR9BcAAN0SgAASNvQAAAADdBnshFFSwn/wAAAwAAAwAB7YZ+YfJAAOwAkxZiAgABvNIACVqdYAAbcqMAAPcquAAH1LsAAJ5gAAAAGgGe53RGfwAAAwAAAwAAXHUAADAAADAEfmAAdQAAABoBnulqRn8AAAMAAAMAAKRhXQADAAADABVxgAAAAGhBmu5JqEFsmUwIb//+qlUAAAMAAH8yQAB7sgACKrBcSAAIKXS4AAd8MAAG7xwAApriMAASJiQAAXfPOAACmvmAACNqrgAB2OyYAAm0kwABRZvgABCrlAAC7SfAABqJMAAHpZugAAAzQZ8MRRUsJ/8AAAMAAAMA5nIA/VBzAADYASYsxBwAA3mjABLVOsAANuVGAAHuVnAACuYAAAAXAZ8rdEZ/AAADAAADABSsSqyAYAC6zAAAdQAAABkBny1qRn8AAAMAAAMAFGpKrIBgAMDOJKAAdQA='
      
      const video = document.createElement('video')
      video.setAttribute('playsinline', '')
      video.setAttribute('muted', '')
      video.setAttribute('loop', '')
      video.setAttribute('src', mp4)
      video.style.position = 'fixed'
      video.style.top = '-9999px'
      video.style.left = '-9999px'
      video.style.width = '1px'
      video.style.height = '1px'
      document.body.appendChild(video)
      noSleepVideoRef.current = video
      
      return video
    }
    
    const enableNoSleep = async () => {
      // First try native Wake Lock API (works on desktop browsers)
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          console.log('[WakeLock] Screen wake lock acquired')
          
          wakeLockRef.current.addEventListener('release', () => {
            console.log('[WakeLock] Screen wake lock released')
          })
        }
      } catch (err) {
        console.log('[WakeLock] Native wake lock failed:', err.message)
      }
      
      // Also use video trick as fallback (better for tablets/mobile)
      try {
        const video = createNoSleepVideo()
        if (video) {
          await video.play()
          console.log('[NoSleep] Video wake lock enabled')
        }
      } catch (err) {
        console.log('[NoSleep] Video wake lock failed:', err.message)
      }
    }

    // Enable on user interaction (required on some devices)
    const handleInteraction = () => {
      enableNoSleep()
      document.removeEventListener('click', handleInteraction)
      document.removeEventListener('touchstart', handleInteraction)
    }
    
    enableNoSleep()
    document.addEventListener('click', handleInteraction, { once: true })
    document.addEventListener('touchstart', handleInteraction, { once: true })

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        enableNoSleep()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      document.removeEventListener('click', handleInteraction)
      document.removeEventListener('touchstart', handleInteraction)
      if (wakeLockRef.current) {
        wakeLockRef.current.release()
        wakeLockRef.current = null
      }
      if (noSleepVideoRef.current) {
        noSleepVideoRef.current.pause()
        noSleepVideoRef.current.remove()
        noSleepVideoRef.current = null
      }
    }
  }, [])
  const [connectionStatuses, setConnectionStatuses] = useState({
    api: 'unknown',
    server: 'unknown',
    websocket: 'unknown',
    scoreboard: 'unknown',
    match: 'unknown',
    db: 'unknown'
  })
  const [connectionDebugInfo, setConnectionDebugInfo] = useState({})
  const [showDebugMenu, setShowDebugMenu] = useState(null) // Which connection type to show debug for

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Single-tab enforcement - prevent opening scoresheet in multiple tabs for same match
  useEffect(() => {
    if (!matchId) return

    const channelName = `scoresheet-${matchId}`
    const storageKey = `scoresheet-active-${matchId}`
    const tabId = tabIdRef.current

    // Try to claim this tab as active
    const existingTab = localStorage.getItem(storageKey)
    if (existingTab && existingTab !== tabId) {
      // Another tab might be active, check via BroadcastChannel
      try {
        const channel = new BroadcastChannel(channelName)

        // Ask if any other tab is active
        const checkTimeout = setTimeout(() => {
          // No response, claim the tab
          localStorage.setItem(storageKey, tabId)
          channel.close()
        }, 200)

        channel.onmessage = (event) => {
          if (event.data.type === 'PING') {
            // Another tab is checking, respond
            channel.postMessage({ type: 'PONG', tabId: tabId })
          } else if (event.data.type === 'PONG' && event.data.tabId !== tabId) {
            // Another tab responded, this is a duplicate
            clearTimeout(checkTimeout)
            setDuplicateTabError(true)
            channel.close()
          } else if (event.data.type === 'NEW_TAB' && event.data.tabId !== tabId) {
            // A new tab just opened, tell it we're here
            channel.postMessage({ type: 'PONG', tabId: tabId })
          }
        }

        // Announce ourselves
        channel.postMessage({ type: 'NEW_TAB', tabId: tabId })

        return () => {
          clearTimeout(checkTimeout)
          channel.close()
          // Only remove from storage if we're the active tab
          if (localStorage.getItem(storageKey) === tabId) {
            localStorage.removeItem(storageKey)
          }
        }
      } catch {
        // BroadcastChannel not supported, fall back to localStorage only
        localStorage.setItem(storageKey, tabId)
      }
    } else {
      // Claim this tab as active
      localStorage.setItem(storageKey, tabId)
    }

    // Set up BroadcastChannel for ongoing communication
    let channel
    try {
      channel = new BroadcastChannel(channelName)

      channel.onmessage = (event) => {
        if (event.data.type === 'PING' || event.data.type === 'NEW_TAB') {
          // Another tab is checking or just opened, respond
          channel.postMessage({ type: 'PONG', tabId: tabId })
        }
      }
    } catch {
      // BroadcastChannel not supported
    }

    // Listen for storage events (when another tab changes localStorage)
    const handleStorage = (e) => {
      if (e.key === storageKey && e.newValue && e.newValue !== tabId) {
        // Another tab just claimed active status
        setDuplicateTabError(true)
      }
    }
    window.addEventListener('storage', handleStorage)

    return () => {
      window.removeEventListener('storage', handleStorage)
      if (channel) channel.close()
      // Only remove from storage if we're the active tab
      if (localStorage.getItem(storageKey) === tabId) {
        localStorage.removeItem(storageKey)
      }
    }
  }, [matchId])

  // Send heartbeat to indicate scoresheet is active
  useEffect(() => {
    if (!matchId) return
    
    const updateHeartbeat = async () => {
      try {
        await db.matches.update(matchId, {
          updatedAt: new Date().toISOString()
        })
      } catch (error) {
        // Silently fail - not critical
      }
    }
    
    // Initial heartbeat
    updateHeartbeat()
    
    // Update heartbeat every 10 seconds
    const interval = setInterval(updateHeartbeat, 10000)
    
    return () => clearInterval(interval)
  }, [matchId])

  // Screen size detection for display mode suggestions
  // Improved detection: check both screen size and touch capability
  // < 600px + touch = smartphone, 600-900px + touch = tablet, > 900px or no touch = desktop
  useEffect(() => {
    const checkScreenSize = () => {
      const width = window.innerWidth
      const height = window.innerHeight
      const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0)
      let detected = 'desktop'
      let suggestion = null

      // Smartphone: narrow screen (<= 600px) with touch, or very narrow (<= 480px) even without touch
      if ((width <= 600 && hasTouch) || width <= 480) {
        detected = 'smartphone'
        suggestion = 'smartphone'
      }
      // Tablet: medium screen (600-900px) with touch
      else if (width <= 900 && hasTouch) {
        detected = 'tablet'
        suggestion = 'tablet'
      }
      // Desktop: > 900px OR no touch capability
      // This ensures laptops are always desktop even if screen is narrower

      setDetectedDisplayMode(detected)

      // Only show suggestion if in auto mode and we detected a smaller screen
      if (displayMode === 'auto' && suggestion) {
        // Check if user already dismissed this suggestion
        const dismissedSuggestion = sessionStorage.getItem('displayModeSuggestionDismissed')
        if (!dismissedSuggestion) {
          setDisplayModeSuggestion(suggestion)
          setShowDisplayModeSuggestion(true)
        }
      }
    }

    // Check on mount
    checkScreenSize()

    // Check on resize
    window.addEventListener('resize', checkScreenSize)
    return () => window.removeEventListener('resize', checkScreenSize)
  }, [displayMode])

  // Get the active display mode (either forced or auto-detected)
  const activeDisplayMode = displayMode === 'auto' ? detectedDisplayMode : displayMode

  // Fullscreen and orientation lock for tablet/smartphone modes
  const enterDisplayMode = useCallback((mode) => {
    // Request fullscreen
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(err => {
        console.log('Fullscreen request failed:', err)
      })
    }

    // Try to lock orientation to landscape (may not work on all browsers)
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(err => {
        console.log('Orientation lock failed:', err)
      })
    }

    // Set the display mode
    setDisplayMode(mode)
    localStorage.setItem('displayMode', mode)
    setShowDisplayModeSuggestion(false)
    sessionStorage.setItem('displayModeSuggestionDismissed', 'true')
  }, [])

  // Exit fullscreen and reset to desktop mode
  const exitDisplayMode = useCallback(() => {
    if (document.exitFullscreen && document.fullscreenElement) {
      document.exitFullscreen().catch(err => {
        console.log('Exit fullscreen failed:', err)
      })
    }

    // Unlock orientation
    if (screen.orientation && screen.orientation.unlock) {
      screen.orientation.unlock()
    }

    setDisplayMode('desktop')
    localStorage.setItem('displayMode', 'desktop')
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

    // Debug: log current set detection
    if (sets.length > 0) {
      console.log('[useLiveQuery] Sets:', sets.map(s => ({ id: s.id, index: s.index, finished: s.finished, points: `${s.homePoints}-${s.awayPoints}` })))
      console.log('[useLiveQuery] Current set:', currentSet ? { id: currentSet.id, index: currentSet.index, finished: currentSet.finished } : 'null')
    }

    const [homePlayers, awayPlayers] = await Promise.all([
      match?.homeTeamId
        ? db.players.where('teamId').equals(match.homeTeamId).sortBy('number')
        : [],
      match?.awayTeamId
        ? db.players.where('teamId').equals(match.awayTeamId).sortBy('number')
        : []
    ])

    // Get all events for the match (keep logs across sets)
    // Sort by seq if available, otherwise by ts
    const eventsRaw = await db.events
      .where('matchId')
      .equals(matchId)
      .toArray()
    
    const events = eventsRaw.sort((a, b) => {
      // Sort by sequence number if available
      const aSeq = a.seq || 0
      const bSeq = b.seq || 0
      if (aSeq !== 0 || bSeq !== 0) {
        return aSeq - bSeq // Ascending
      }
      // Fallback to timestamp for legacy events
      const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
      const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
      return aTime - bTime
    })
    
    // Log all action IDs to track sequence numbers (show only base integer IDs, not decimals)
    const baseActionIds = events
      .map(e => {
        const seq = e.seq || 0
        return Math.floor(seq) // Get integer part only
      })
      .filter(id => id > 0)
      .filter((id, index, self) => self.indexOf(id) === index) // Remove duplicates
    
    // Action IDs tracked internally

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

  // Connect to WebSocket server and sync match data
  useEffect(() => {
    // If no matchId, clear all matches from server (scoreboard is source of truth)
    if (!matchId) {
      const clearAllMatches = () => {
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: 'clear-all-matches'
            }))
          } catch (err) {
            // Silently ignore
          }
        }
      }
      
      // Try to clear immediately if WebSocket is open
      clearAllMatches()
      
      // Also set up a connection to clear when WebSocket opens
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const hostname = window.location.hostname
      const wsPort = 8080
      const wsUrl = `${protocol}://${hostname}:${wsPort}`
      
      const tempWs = new WebSocket(wsUrl)
      tempWs.onopen = () => {
        tempWs.send(JSON.stringify({ type: 'clear-all-matches' }))
        tempWs.close()
      }
      tempWs.onerror = () => {
        // Ignore - server might not be running
      }
      
      return () => {
        if (tempWs.readyState === WebSocket.OPEN || tempWs.readyState === WebSocket.CONNECTING) {
          tempWs.close()
        }
      }
    }
    
    if (!data || !data.match) {
      // Data is still loading - this is expected, wait for it
      return
    }

    let ws = null
    let reconnectTimeout = null

    const connectWebSocket = () => {
      try {
        // Check if we have a configured backend URL (Railway/cloud backend)
        const backendUrl = import.meta.env.VITE_BACKEND_URL

        let wsUrl
        if (backendUrl) {
          // Use configured backend (Railway cloud)
          const url = new URL(backendUrl)
          const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
          wsUrl = `${protocol}//${url.host}`
        } else {
          // Fallback to local WebSocket server (development/Electron)
          const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
          const hostname = window.location.hostname
          let wsPort = 8080
          // Check if we have server status (from Electron or previous API call)
          const currentServerStatus = serverStatus
          if (currentServerStatus?.wsPort) {
            wsPort = currentServerStatus.wsPort
          }
          wsUrl = `${protocol}://${hostname}:${wsPort}`
        }

        ws = new WebSocket(wsUrl)
        wsRef.current = ws // Store in ref for use in callbacks
        
        // Set error handler first to catch any immediate errors
        ws.onerror = () => {
          // Suppress - browser will show native errors if needed
        }

        ws.onopen = () => {
          // Clear all other matches first (scoreboard is source of truth - only current match should exist)
          try {
            ws.send(JSON.stringify({
              type: 'clear-all-matches',
              keepMatchId: String(matchId) // Keep only the current match
            }))
          } catch (err) {
            // Silently ignore WebSocket errors
          }
          
          // Send initial match data sync (this will overwrite/add the current match)
          // No periodic sync - data is synced only when actions occur
          syncMatchData()
        }

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data)
            
            if (message.type === 'pin-validation-request') {
              // Respond to PIN validation request
              handlePinValidationRequest(message)
            } else if (message.type === 'match-data-request') {
              // Respond to match data request
              handleMatchDataRequest(message)
            } else if (message.type === 'game-number-request') {
              // Respond to game number request
              handleGameNumberRequest(message)
            } else if (message.type === 'pong') {
              // Heartbeat response
            }
          } catch (err) {
            console.error('[WebSocket] Error parsing message:', err)
          }
        }


        ws.onclose = (event) => {
          // Don't reconnect on normal closure (code 1000)
          if (event.code === 1000) {
            return
          }
          // Reconnect after 5 seconds
          reconnectTimeout = setTimeout(connectWebSocket, 5000)
        }
      } catch (err) {
        console.error('[WebSocket] Connection error:', err)
      }
    }

    const syncMatchData = async () => {
      // Use wsRef.current to always get the current WebSocket (not stale closure)
      const currentWs = wsRef.current
      if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
        return
      }

      try {
        // Fetch ALL fresh data from IndexedDB (not from React state which may be stale due to closures)
        const freshMatch = await db.matches.get(matchId)
        if (!freshMatch) return

        const [freshHomeTeam, freshAwayTeam, freshSets, freshEvents, freshHomePlayers, freshAwayPlayers] = await Promise.all([
          db.teams.get(freshMatch?.homeTeamId),
          db.teams.get(freshMatch?.awayTeamId),
          db.sets.where('matchId').equals(matchId).toArray(),
          db.events.where('matchId').equals(matchId).toArray(),
          freshMatch?.homeTeamId ? db.players.where('teamId').equals(freshMatch.homeTeamId).toArray() : [],
          freshMatch?.awayTeamId ? db.players.where('teamId').equals(freshMatch.awayTeamId).toArray() : []
        ])

        // Sync full match data to server - this ALWAYS overwrites existing data (scoreboard is source of truth)
        // The server will replace all data for this matchId with this data
        const sendTimestamp = Date.now()
        const syncPayload = {
          type: 'sync-match-data',
          matchId: matchId,
          match: freshMatch,
          homeTeam: freshHomeTeam || null,
          awayTeam: freshAwayTeam || null,
          homePlayers: freshHomePlayers || [],
          awayPlayers: freshAwayPlayers || [],
          sets: freshSets || [],
          events: freshEvents || [],
          _timestamp: sendTimestamp // Track when sent from scoreboard
        }

        currentWs.send(JSON.stringify(syncPayload))
      } catch (err) {
        console.error('[WebSocket] Error syncing match data:', err)
      }
    }

    // Store sync function in ref so it can be called from action handlers
    syncFunctionRef.current = syncMatchData

    const handlePinValidationRequest = async (request) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return

      try {
        const { pin, pinType, requestId } = request
        const pinStr = String(pin).trim()

        // Fetch fresh match data from IndexedDB (not from React state which may be stale due to closures)
        const freshMatch = await db.matches.get(matchId)
        if (!freshMatch) {
          ws.send(JSON.stringify({
            type: 'pin-validation-response',
            requestId,
            success: false,
            error: 'Match not found'
          }))
          return
        }

        // Check if PIN matches
        let matchPin = null
        let connectionEnabled = false

        if (pinType === 'referee') {
          matchPin = freshMatch.refereePin
          connectionEnabled = freshMatch.refereeConnectionEnabled !== false
        } else if (pinType === 'homeTeam') {
          matchPin = freshMatch.homeTeamPin
          connectionEnabled = freshMatch.homeTeamConnectionEnabled !== false
        } else if (pinType === 'awayTeam') {
          matchPin = freshMatch.awayTeamPin
          connectionEnabled = freshMatch.awayTeamConnectionEnabled !== false
        }

        if (matchPin && String(matchPin).trim() === pinStr && connectionEnabled && freshMatch.status !== 'final') {
          // Fetch all related data fresh from IndexedDB
          const [freshHomeTeam, freshAwayTeam, freshSets, freshEvents, freshHomePlayers, freshAwayPlayers] = await Promise.all([
            db.teams.get(freshMatch?.homeTeamId),
            db.teams.get(freshMatch?.awayTeamId),
            db.sets.where('matchId').equals(matchId).toArray(),
            db.events.where('matchId').equals(matchId).toArray(),
            freshMatch?.homeTeamId ? db.players.where('teamId').equals(freshMatch.homeTeamId).toArray() : [],
            freshMatch?.awayTeamId ? db.players.where('teamId').equals(freshMatch.awayTeamId).toArray() : []
          ])

          // Send match data with full data
          ws.send(JSON.stringify({
            type: 'pin-validation-response',
            requestId,
            success: true,
            match: {
              id: freshMatch.id,
              refereePin: freshMatch.refereePin,
              homeTeamPin: freshMatch.homeTeamPin,
              awayTeamPin: freshMatch.awayTeamPin,
              homeTeamUploadPin: freshMatch.homeTeamUploadPin,
              awayTeamUploadPin: freshMatch.awayTeamUploadPin,
              refereeConnectionEnabled: freshMatch.refereeConnectionEnabled,
              homeTeamConnectionEnabled: freshMatch.homeTeamConnectionEnabled,
              awayTeamConnectionEnabled: freshMatch.awayTeamConnectionEnabled,
              status: freshMatch.status,
              homeTeamId: freshMatch.homeTeamId,
              awayTeamId: freshMatch.awayTeamId,
              gameNumber: freshMatch.gameNumber,
              game_n: freshMatch.game_n,
              createdAt: freshMatch.createdAt,
              updatedAt: freshMatch.updatedAt
            },
            fullData: {
              matchId: matchId,
              match: freshMatch,
              homeTeam: freshHomeTeam || null,
              awayTeam: freshAwayTeam || null,
              homePlayers: freshHomePlayers || [],
              awayPlayers: freshAwayPlayers || [],
              sets: freshSets || [],
              events: freshEvents || []
            }
          }))
        } else {
          // PIN doesn't match or connection disabled
          ws.send(JSON.stringify({
            type: 'pin-validation-response',
            requestId,
            success: false,
            error: connectionEnabled === false 
              ? 'Connection is disabled for this match'
              : 'Invalid PIN code'
          }))
        }
      } catch (err) {
        console.error('[WebSocket] Error handling PIN validation:', err)
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'pin-validation-response',
            requestId: request.requestId,
            success: false,
            error: 'Error validating PIN'
          }))
        }
      }
    }

    const handleMatchDataRequest = async (request) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return

      try {
        const { requestId, matchId: requestedMatchId } = request

        if (String(requestedMatchId) !== String(matchId)) {
          ws.send(JSON.stringify({
            type: 'match-data-response',
            requestId,
            matchId: requestedMatchId,
            success: false,
            error: 'Match ID mismatch'
          }))
          return
        }

        // Fetch ALL fresh data from IndexedDB (not from React state which may be stale due to closures)
        const freshMatch = await db.matches.get(matchId)
        if (!freshMatch) {
          ws.send(JSON.stringify({
            type: 'match-data-response',
            requestId,
            matchId: requestedMatchId,
            success: false,
            error: 'Match not found in database'
          }))
          return
        }

        const [freshHomeTeam, freshAwayTeam, freshSets, freshEvents, freshHomePlayers, freshAwayPlayers] = await Promise.all([
          db.teams.get(freshMatch?.homeTeamId),
          db.teams.get(freshMatch?.awayTeamId),
          db.sets.where('matchId').equals(matchId).toArray(),
          db.events.where('matchId').equals(matchId).toArray(),
          freshMatch?.homeTeamId ? db.players.where('teamId').equals(freshMatch.homeTeamId).toArray() : [],
          freshMatch?.awayTeamId ? db.players.where('teamId').equals(freshMatch.awayTeamId).toArray() : []
        ])

        ws.send(JSON.stringify({
          type: 'match-data-response',
          requestId,
          matchId: matchId,
          success: true,
          data: {
            match: freshMatch,
            homeTeam: freshHomeTeam || null,
            awayTeam: freshAwayTeam || null,
            homePlayers: freshHomePlayers || [],
            awayPlayers: freshAwayPlayers || [],
            sets: freshSets || [],
            events: freshEvents || []
          }
        }))
      } catch (err) {
        console.error('[WebSocket] Error handling match data request:', err)
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'match-data-response',
            requestId: request.requestId,
            matchId: request.matchId,
            success: false,
            error: 'Error fetching match data'
          }))
        }
      }
    }

    const handleGameNumberRequest = async (request) => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !data?.match) return

      try {
        const { requestId, gameNumber } = request
        const gameNumStr = String(gameNumber).trim()
        
        const matchGameNumber = String(data.match.gameNumber || '')
        const matchGameN = String(data.match.game_n || '')
        const matchIdStr = String(data.match.id || '')
        
        if (matchGameNumber === gameNumStr || matchGameN === gameNumStr || matchIdStr === gameNumStr) {
          ws.send(JSON.stringify({
            type: 'game-number-response',
            requestId,
            success: true,
            match: data.match,
            matchId: matchId
          }))
        } else {
          ws.send(JSON.stringify({
            type: 'game-number-response',
            requestId,
            success: false,
            error: 'Match not found with this game number'
          }))
        }
      } catch (err) {
        console.error('[WebSocket] Error handling game number request:', err)
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'game-number-response',
            requestId: request.requestId,
            success: false,
            error: 'Error finding match'
          }))
        }
      }
    }

    // Removed handleMatchUpdateRequest - using sync-match-data instead

    // When matchId changes, clear the old match from server
    if (previousMatchIdRef.current && previousMatchIdRef.current !== matchId) {
      const oldMatchId = previousMatchIdRef.current
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'delete-match',
            matchId: String(oldMatchId)
          }))
        } catch (err) {
          // Silently ignore
        }
      }
    }
    previousMatchIdRef.current = matchId

    // Connect to WebSocket
    connectWebSocket()

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
      
      // Clear all matches from server when component unmounts (scoreboard is source of truth)
      if (wsRef.current) {
        const ws = wsRef.current
        const readyState = ws.readyState
        
        // Clear all matches from server before closing
        if (readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: 'clear-all-matches'
            }))
          } catch (err) {
            // Silently ignore errors during cleanup
          }
        }
        
        // Remove all handlers first to prevent error logs
        try {
          ws.onerror = null
          ws.onclose = null
          ws.onopen = null
          ws.onmessage = null
        } catch (err) {
          // Ignore if handlers can't be set
        }
        
        // Only try to close if connection is OPEN
        // Don't close if CONNECTING - let it fail naturally to avoid browser errors
        if (readyState === WebSocket.OPEN) {
          try {
            ws.close(1000, 'Component unmounting')
          } catch (err) {
            // Ignore errors during cleanup
          }
        }
        // For CONNECTING or CLOSING states, just null the ref
        wsRef.current = null
      }
    }
  }, [matchId, serverStatus])

  // Sync data to referee/bench - call this after any action that changes match data
  const syncToReferee = useCallback(() => {
    if (syncFunctionRef.current) {
      syncFunctionRef.current()
    }
  }, [])

  // Send action to referee/bench for showing modals/countdowns
  const sendActionToReferee = useCallback((actionType, actionData) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return
    }

    const sendTimestamp = Date.now()
    const actionPayload = {
      type: 'match-action',
      matchId: matchId,
      action: actionType,
      data: actionData,
      timestamp: sendTimestamp,
      _timestamp: sendTimestamp // For latency tracking
    }
    
    ws.send(JSON.stringify(actionPayload))
  }, [matchId])

  // Check connection statuses
  const checkConnectionStatuses = useCallback(async () => {
    const statuses = {
      api: 'unknown',
      server: 'unknown',
      websocket: 'unknown',
      scoreboard: 'unknown',
      match: 'unknown',
      db: 'unknown'
    }
    const debugInfo = {}
    
    // Check API/Server connection
    try {
      const response = await fetch('/api/match/list')
      if (response.ok) {
        statuses.api = 'connected'
        statuses.server = 'connected'
        debugInfo.api = { status: 'connected', message: 'API endpoint responding' }
        debugInfo.server = { status: 'connected', message: 'Server is reachable' }
      } else {
        statuses.api = 'disconnected'
        statuses.server = 'disconnected'
        debugInfo.api = { status: 'disconnected', message: `API returned status ${response.status}: ${response.statusText}` }
        debugInfo.server = { status: 'disconnected', message: `Server returned status ${response.status}: ${response.statusText}` }
      }
    } catch (err) {
      statuses.api = 'disconnected'
      statuses.server = 'disconnected'
      const errMsg = import.meta.env.DEV
        ? `Network error: ${err.message || 'Failed to connect to API'}`
        : 'Server not available (running in standalone mode)'
      debugInfo.api = { status: 'disconnected', message: errMsg }
      debugInfo.server = { status: 'disconnected', message: errMsg }
    }
    
    // Check WebSocket connection
    if (wsRef.current) {
      const ws = wsRef.current
      if (ws.readyState === WebSocket.OPEN) {
        statuses.websocket = 'connected'
      } else if (ws.readyState === WebSocket.CONNECTING) {
        statuses.websocket = 'connecting'
      } else {
        statuses.websocket = 'disconnected'
      }
    } else {
      // Test if WebSocket server is available
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
        const hostname = window.location.hostname
        const wsPort = serverStatus?.wsPort || 8080
        const wsUrl = `${protocol}://${hostname}:${wsPort}`
        
        const wsTest = new WebSocket(wsUrl)
        let resolved = false
        
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            if (!resolved) {
              resolved = true
              try {
                if (wsTest.readyState === WebSocket.CONNECTING || wsTest.readyState === WebSocket.OPEN) {
                  wsTest.close()
                }
              } catch (e) {
                // Ignore errors when closing
              }
              statuses.websocket = 'disconnected'
              resolve()
            }
          }, 2000)
          
          wsTest.onopen = () => {
            if (!resolved) {
              resolved = true
              clearTimeout(timeout)
              try {
                wsTest.close()
              } catch (e) {
                // Ignore errors when closing
              }
              statuses.websocket = 'connected'
              resolve()
            }
          }
          
          wsTest.onerror = () => {
            if (!resolved) {
              resolved = true
              clearTimeout(timeout)
              try {
                if (wsTest.readyState === WebSocket.CONNECTING || wsTest.readyState === WebSocket.OPEN) {
                  wsTest.close()
                }
              } catch (e) {
                // Ignore errors when closing
              }
              statuses.websocket = 'disconnected'
              resolve()
            }
          }
          
          wsTest.onclose = () => {
            if (!resolved) {
              resolved = true
              clearTimeout(timeout)
              statuses.websocket = 'disconnected'
              resolve()
            }
          }
        })
      } catch (err) {
        statuses.websocket = 'disconnected'
      }
    }
    
    // Check Scoreboard connection (same as server for now)
    statuses.scoreboard = statuses.server
    
    // Check Match status
    if (data?.match) {
      statuses.match = data.match.status === 'live' ? 'live' : data.match.status === 'scheduled' ? 'scheduled' : data.match.status === 'final' ? 'final' : 'unknown'
    } else {
      statuses.match = 'no_match'
    }
    
    // Check DB (IndexedDB) - always available in browser
    try {
      await db.matches.count()
      statuses.db = 'connected'
    } catch (err) {
      statuses.db = 'disconnected'
    }
    
    setConnectionStatuses(statuses)
  }, [data?.match, serverStatus])

  // Periodically check connection statuses
  useEffect(() => {
    checkConnectionStatuses()
    const interval = setInterval(checkConnectionStatuses, 5000) // Check every 5 seconds
    return () => clearInterval(interval)
  }, [checkConnectionStatuses])

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
        // Silently handle error
      })
      .finally(() => {
        ensuringSetRef.current = false
      })
  }, [data, ensureActiveSet, matchId])

  // Sync remarks text when modal opens
  useEffect(() => {
    if (showRemarks) {
      const currentRemarks = data?.match?.remarks || ''
      // If there are existing remarks, add a newline at the end for new input
      setRemarksText(currentRemarks ? `${currentRemarks}\n` : '')
      // Focus textarea after modal opens
      setTimeout(() => {
        if (remarksTextareaRef.current) {
          remarksTextareaRef.current.focus()
          const len = remarksTextareaRef.current.value.length
          remarksTextareaRef.current.setSelectionRange(len, len)
        }
      }, 100)
    }
  }, [showRemarks, data?.match?.remarks])

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
      // In browser/PWA - show instructions instead of error
      // The server status will be checked automatically, so we just need to show instructions
      return
    }
    
    setServerLoading(true)
    try {
      const result = await window.electronAPI.server.start({ https: true })
      if (result.success) {
        setServerStatus(result.status)
        setServerRunning(true)
      } else {
        alert(`Failed to start server: ${result.error}`)
      }
    } catch (error) {
      alert(`Error starting server: ${error.message}`)
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
      alert(`Error stopping server: ${error.message}`)
    } finally {
      setServerLoading(false)
    }
  }

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
    // Before coin toss, default to home left, away right
    const isBeforeCoinToss = !data?.match?.coinTossTeamA || !data?.match?.coinTossTeamB
    if (isBeforeCoinToss || !data?.set) return true
    
    const setIndex = data.set.index
    
    // Check for manual override first (for sets 1-4)
    if (setIndex >= 1 && setIndex <= 4 && data.match?.setLeftTeamOverrides) {
      const override = data.match.setLeftTeamOverrides[setIndex]
      if (override) {
        // Override is 'A' or 'B'
        const leftTeamKey = override === 'A' ? teamAKey : teamBKey
        return leftTeamKey === 'home'
      }
    }
    
    // Set 1: Team A on left
    if (setIndex === 1) {
      return teamAKey === 'home'
    } 
    
    // Set 5: Special case with court switch at 8 points
    if (setIndex === 5) {
      // Use set5LeftTeam if specified, otherwise default to teams switched (like set 2)
      if (data.match?.set5LeftTeam) {
        const leftTeamKey = data.match.set5LeftTeam === 'A' ? teamAKey : teamBKey
        let isHome = leftTeamKey === 'home'
        
        // If court switch has happened at 8 points, switch again
        if (data.match?.set5CourtSwitched) {
          isHome = !isHome
        }
        
        return isHome
      }
      
      // Fallback: Set 5 starts with teams switched (like set 2)
      let isHome = teamAKey !== 'home'
      
      // If court switch has happened at 8 points, switch again
      if (data.match?.set5CourtSwitched) {
        isHome = !isHome
      }
      
      return isHome
    }
    
    // Sets 2, 3, 4: Teams alternate sides (automatic if no override)
    // Set 1: Team A left, Team B right
    // Set 2: Team A right, Team B left (switched)
    // Set 3: Team A left, Team B right (switched back - same as Set 1)
    // Set 4: Team A right, Team B left (switched - same as Set 2)
    // Pattern: odd sets (1, 3) have Team A on left, even sets (2, 4) have Team A on right
    return setIndex % 2 === 1 ? (teamAKey === 'home') : (teamAKey !== 'home')
  }, [data?.set, data?.match?.set5CourtSwitched, data?.match?.set5LeftTeam, data?.match?.setLeftTeamOverrides, teamAKey])

  // Calculate set score (number of sets won by each team)
  const setScore = useMemo(() => {
    if (!data) return { home: 0, away: 0, left: 0, right: 0 }
    
    const allSets = data.sets || []
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

  const mapTeamKeyToSide = useCallback(
    teamKey => {
      if (!data?.set) return 'left'
      if (teamKey === 'home') {
        return leftIsHome ? 'left' : 'right'
      }
      return leftIsHome ? 'right' : 'left'
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
    
    // Get events for current set only and sort by sequence number (most recent first)
    const currentSetEvents = data.events
      .filter(e => e.setIndex === data.set.index)
      .sort((a, b) => {
        // Sort by sequence number if available, otherwise by timestamp
        const aSeq = a.seq || 0
        const bSeq = b.seq || 0
        if (aSeq !== 0 || bSeq !== 0) {
          return bSeq - aSeq // Descending by sequence (most recent first)
        }
        // Fallback to timestamp for legacy events
        const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
        const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
        return bTime - aTime
      })
    
    if (currentSetEvents.length === 0) return 'idle'
    
    const lastEvent = currentSetEvents[0] // Most recent event is now first
    
    // Check if last event is point or replay first (these end the rally)
    if (lastEvent.type === 'point' || lastEvent.type === 'replay') {
      return 'idle'
    }
    
    if (lastEvent.type === 'rally_start') {
      return 'in_play'
    }
    
    // set_start means set is ready but rally hasn't started yet
    if (lastEvent.type === 'set_start') {
      return 'idle'
    }
    
    // For lineup events after points, the rally is idle (waiting for next rally_start)
    return 'idle'
  }, [data?.events, data?.set])

  // Check if the rally is replayed (last event is a replay)
  const isRallyReplayed = useMemo(() => {
    if (!data?.events || !data?.set || data.events.length === 0) return false
    
    // Get events for current set only and sort by sequence number (most recent first)
    const currentSetEvents = data.events
      .filter(e => e.setIndex === data.set.index)
      .sort((a, b) => {
        const aSeq = a.seq || 0
        const bSeq = b.seq || 0
        if (aSeq !== 0 || bSeq !== 0) {
          return bSeq - aSeq
        }
        const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
        const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
        return bTime - aTime
      })
    
    if (currentSetEvents.length === 0) return false
    
    const lastEvent = currentSetEvents[0]
    return lastEvent.type === 'replay'
  }, [data?.events, data?.set])

  // Check if the last event was a point (can replay rally)
  const canReplayRally = useMemo(() => {
    if (!data?.events || !data?.set || data.events.length === 0) return false

    // Get events for current set only and sort by sequence number (most recent first)
    const currentSetEvents = data.events
      .filter(e => e.setIndex === data.set.index)
      .sort((a, b) => {
        const aSeq = a.seq || 0
        const bSeq = b.seq || 0
        if (aSeq !== 0 || bSeq !== 0) {
          return bSeq - aSeq
        }
        const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
        const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
        return bTime - aTime
      })

    if (currentSetEvents.length === 0) return false

    const lastEvent = currentSetEvents[0]
    // Can replay rally if the last event was a point
    return lastEvent.type === 'point'
  }, [data?.events, data?.set])

  const isFirstRally = useMemo(() => {
    if (!data?.events || !data?.set) return true
    // Check if there are any points in the current set
    // This determines if we show "Start set" vs "Start rally"
    const hasPoints = data.events.some(e => e.type === 'point' && e.setIndex === data.set.index)
    return !hasPoints
  }, [data?.events, data?.set])

  // Check if we're between sets (previous set finished, current set hasn't started)
  const isBetweenSets = useMemo(() => {
    if (!data?.sets || !data?.set) return false
    const allSets = data.sets.sort((a, b) => a.index - b.index)
    const currentSetIndex = data.set.index
    if (currentSetIndex === 1) return false // First set, not between sets
    
    const previousSet = allSets.find(s => s.index === currentSetIndex - 1)
    if (!previousSet || !previousSet.finished) return false
    
    // Check if current set has started (has points or set_start event)
    const hasSetStarted = data.events?.some(e => 
      (e.type === 'point' || e.type === 'set_start') && e.setIndex === currentSetIndex
    )
    
    return !hasSetStarted
  }, [data?.sets, data?.set, data?.events])

  // Start between-sets countdown when we detect we're between sets
  useEffect(() => {
    // Only start countdown if between sets AND countdown is null (not started yet)
    // Don't restart if countdown exists (even if finished) or was dismissed
    if (isBetweenSets && betweenSetsCountdown === null && !countdownDismissedRef.current) {
      setBetweenSetsCountdown({ countdown: setIntervalDuration, started: true })
    } else if (!isBetweenSets) {
      // Reset to null only when no longer between sets (new set started)
      setBetweenSetsCountdown(null)
      countdownDismissedRef.current = false // Reset for next time
    }
  }, [isBetweenSets, setIntervalDuration]) // Removed betweenSetsCountdown from deps to prevent restart loop

  // Handle between-sets countdown timer
  useEffect(() => {
    if (!betweenSetsCountdown || !betweenSetsCountdown.started) return

    // Don't set interval if already at 0
    if (betweenSetsCountdown.countdown <= 0) return

    const timer = setInterval(() => {
      setBetweenSetsCountdown(prev => {
        if (!prev || !prev.started) return prev
        const newCountdown = prev.countdown - 1
        if (newCountdown <= 0) {
          // Stay at 0, don't reset to null - this prevents restart
          return { countdown: 0, started: false }
        }
        return { ...prev, countdown: newCountdown }
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [betweenSetsCountdown])

  // Format countdown time: ' and '' (no ' when less than a minute)
  const formatCountdown = useCallback((seconds) => {
    if (seconds < 60) {
      return `${seconds}''`
    }
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    if (remainingSeconds === 0) {
      return `${minutes}'`
    }
    return `${minutes}' ${remainingSeconds}''`
  }, [])

  const stopBetweenSetsCountdown = useCallback(() => {
    setBetweenSetsCountdown(null)
  }, [])

  const endSetInterval = useCallback(() => {
    // Clear countdown and mark as dismissed so it doesn't restart
    setBetweenSetsCountdown(null)
    countdownDismissedRef.current = true
    // The set will start when user clicks "Start set" button
  }, [])

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
      .sort((a, b) => {
        // Sort by sequence number
        const aSeq = a.seq || 0
        const bSeq = b.seq || 0
        if (aSeq !== 0 || bSeq !== 0) {
          return aSeq - bSeq // Ascending
        }
        // Fallback to timestamp
        return new Date(a.ts) - new Date(b.ts)
      })

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
    
    
    // Ensure currentLineup only has valid positions (defensive check against 7 players bug)
    // If a position has an empty string, try to recover it from previous lineup events
    const validPositions = ['I', 'II', 'III', 'IV', 'V', 'VI']
    const cleanedCurrentLineup = {}
    
    // First pass: collect all valid player numbers from current lineup
    const currentPlayerNumbers = new Set()
    for (const pos of validPositions) {
      const playerNumber = currentLineup[pos]
      if (playerNumber !== undefined && playerNumber !== null && playerNumber !== '') {
        cleanedCurrentLineup[pos] = playerNumber
        currentPlayerNumbers.add(String(playerNumber))
      }
    }
    
    // Second pass: for missing positions, try to recover from previous lineup events
    // but only if the recovered player isn't already on court
    for (const pos of validPositions) {
      if (cleanedCurrentLineup[pos] !== undefined) {
        continue // Already has a valid player
      }
      
      // Look backwards through lineup events to find the last valid player number for this position
      for (let i = lineupEvents.length - 2; i >= 0; i--) {
        const prevLineup = lineupEvents[i]?.payload?.lineup
        const prevPlayerNumber = prevLineup?.[pos]
        if (prevPlayerNumber && prevPlayerNumber !== '' && prevPlayerNumber !== null && prevPlayerNumber !== undefined) {
          // Only use this recovered player if they're not already on court in another position
          const prevPlayerNumberStr = String(prevPlayerNumber)
          if (!currentPlayerNumbers.has(prevPlayerNumberStr)) {
            cleanedCurrentLineup[pos] = prevPlayerNumber
            currentPlayerNumbers.add(prevPlayerNumberStr)
            break
          }
        }
      }
    }
    
    const playersOnCourt = Object.values(cleanedCurrentLineup)
      .filter(num => num !== undefined && num !== null && num !== '')
      .map(num => Number(num))
      .filter(num => !Number.isNaN(num) && num !== 0)
    

    const positionLiberoMap = {}
    const playerLiberoMap = {}

    const findLatestLiberoSubstitution = (liberoNumber) => {
      // Find the most recent libero substitution for this libero, regardless of position
      // This is important because positions change during rotation, but the libero number stays the same
      for (let i = lineupEvents.length - 1; i >= 0; i--) {
        const maybeSub = lineupEvents[i]?.payload?.liberoSubstitution
        if (
          maybeSub &&
          String(maybeSub.liberoNumber) === String(liberoNumber)
        ) {
          return maybeSub
        }
      }
      return null
    }

    for (const [position, playerNumber] of Object.entries(cleanedCurrentLineup)) {
      const player = teamPlayers.find(p => String(p.number) === String(playerNumber))
      if (player?.libero && player.libero !== '') {
        // Find the libero substitution by libero number (not position, since position changes during rotation)
        const subInfo = findLatestLiberoSubstitution(playerNumber)
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
      currentLineup: cleanedCurrentLineup, // Return cleaned lineup
      playersOnCourt,
      positionLiberoMap,
      playerLiberoMap
    }
  }, [data?.events, data?.set, data?.homePlayers, data?.awayPlayers])

  // Check if captain is on court and show modal to select new captain if needed
  const checkAndRequestCaptainOnCourt = useCallback(async (teamKey) => {
    // Check if manage captain on court is enabled
    if (!localManageCaptainOnCourt) return
    
    const teamPlayers = teamKey === 'home' ? data?.homePlayers || [] : data?.awayPlayers || []
    const teamLineupState = getTeamLineupState(teamKey)
    const playersOnCourt = teamLineupState.playersOnCourt || []
    
    // Find team captain
    const teamCaptain = teamPlayers.find(p => p.isCaptain || p.captain)
    if (!teamCaptain) return
    
    // Check if captain is on court
    const captainOnCourt = playersOnCourt.includes(Number(teamCaptain.number))

    // Get current captain on court from match
    const captainOnCourtField = teamKey === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain'
    const currentCourtCaptain = data?.match?.[captainOnCourtField]

    // If team captain is on court, they automatically become captain on court (no need to ask)
    // Team captain has precedence over everyone
    if (captainOnCourt) {
      // Set team captain as court captain (or clear if already set to them)
      if (currentCourtCaptain !== teamCaptain.number) {
        await db.matches.update(matchId, { [captainOnCourtField]: teamCaptain.number })
      }
      return
    }
    
    // Captain is not on court - check if we need to show modal
    // If there's already a court captain and they're still on court, no need to ask
    if (currentCourtCaptain) {
      const courtCaptainOnCourt = playersOnCourt.includes(Number(currentCourtCaptain))
      if (courtCaptainOnCourt) return // Court captain is still on court, no need to ask
    }
    
    // Show modal to select new captain on court
    setCaptainOnCourtModal({ team: teamKey })
  }, [localManageCaptainOnCourt, data, matchId, getTeamLineupState])

  const buildOnCourt = useCallback((players, isLeft, teamKey) => {
    const { currentLineup, positionLiberoMap } = getTeamLineupState(teamKey)

    // Check if there's an INITIAL lineup set for this team in the current set
    const hasInitialLineup = data?.events?.some(e => 
      e.type === 'lineup' && 
      e.payload?.team === teamKey && 
      e.setIndex === data?.set?.index &&
      e.payload?.isInitial === true
    )

    // Fixed positions:
    // Left team: Front row (0,1,2): IV, III, II | Back row (3,4,5): V, VI, I
    // Right team: Front row (0,1,2): II, III, IV | Back row (3,4,5): I, VI, V (I is top right)
    const leftPositions = ['IV', 'III', 'II', 'V', 'VI', 'I']
    const rightPositions = ['II', 'III', 'IV', 'I', 'VI', 'V']
    const fixedPositions = isLeft ? leftPositions : rightPositions

    // If initial lineup hasn't been set for this set, show empty placeholders
    // This ensures all players are on the bench (available for sanctions)
    if (!hasInitialLineup) {
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
    
    // Use the current lineup (could be initial, rotation, or substitution)
    const savedLineup = currentLineup

    // If lineup is saved, use it to map players to fixed positions
    if (savedLineup) {
      // Ensure savedLineup only has valid positions (defensive check)
      const validPositions = ['I', 'II', 'III', 'IV', 'V', 'VI']
      const cleanedLineup = {}
      for (const pos of validPositions) {
        // Only include positions that have a valid player number (not undefined, null, or empty string)
        const playerNumber = savedLineup[pos]
        if (playerNumber !== undefined && playerNumber !== null && playerNumber !== '') {
          cleanedLineup[pos] = playerNumber
        }
      }
      // Ensure we only return exactly 6 players, using only the fixed positions
      const result = fixedPositions.slice(0, 6).map((pos, idx) => {
        const playerNumber = cleanedLineup[pos]
        // Handle both undefined/null and empty string cases, but preserve 0 as valid
        const hasPlayerNumber = playerNumber !== undefined && playerNumber !== null && playerNumber !== ''
        // Convert both to strings for comparison to handle number/string mismatches
        const player = hasPlayerNumber ? players?.find(p => String(p.number) === String(playerNumber)) : null
        const isLibero = player?.libero && player.libero !== ''
        const liberoSub = positionLiberoMap[pos]

        const playerData = {
          id: player?.id ?? `placeholder-${idx}`,
          number: hasPlayerNumber ? String(playerNumber) : '',
          isPlaceholder: !hasPlayerNumber,
          position: pos, // Fixed position on court
          isCaptain: player?.isCaptain || false,
          isLibero: isLibero || !!liberoSub,
          substitutedPlayerNumber: liberoSub?.playerNumber || null,
          liberoType: liberoSub?.liberoType || (isLibero ? player.libero : null)
        }
        return playerData
      })

      // Safety check: ensure we return exactly 6 players
      if (result.length !== 6) {
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
  }, [rallyStatus, isFirstRally, getTeamLineupState, data?.events, data?.set])

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
        .sort((a, b) => {
          // Sort by sequence number
          const aSeq = a.seq || 0
          const bSeq = b.seq || 0
          if (aSeq !== 0 || bSeq !== 0) {
            return aSeq - bSeq // Ascending
          }
          // Fallback to timestamp
          return new Date(a.ts) - new Date(b.ts)
        })

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
        if (Number.isNaN(playerNumber) || playersOnCourtSet.has(playerNumber) || (p.libero && p.libero !== '')) {
          return false
        }
        
        // Keep expelled/disqualified/exceptionally substituted players on bench (they'll show with X)
        // They should be visible but not selectable for substitutions/lineups
        
        return true
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
  }, [data, leftIsHome, getTeamLineupState, teamAKey, data?.events])

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
        if (Number.isNaN(playerNumber) || playersOnCourtSet.has(playerNumber) || (p.libero && p.libero !== '')) {
          return false
        }
        
        // Keep expelled/disqualified/exceptionally substituted players on bench (they'll show with X)
        // They should be visible but not selectable for substitutions/lineups
        
        return true
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
  }, [data, leftIsHome, getTeamLineupState, teamAKey, data?.events])

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

  // Helper function to get next sequence number for events (returns integer only)
  const getNextSeq = useCallback(async () => {
    const allEvents = await db.events.where('matchId').equals(matchId).toArray()
    const coinTossEvent = allEvents.find(e => e.type === 'coin_toss')
    
    // Get the maximum base ID (integer part only, ignoring decimals)
    const maxBaseSeq = allEvents.reduce((max, e) => {
      const seq = e.seq || 0
      const baseSeq = Math.floor(seq) // Get integer part only
      return Math.max(max, baseSeq)
    }, 0)
    
    // If coin toss exists and has seq=1, ensure next seq is at least 2
    // Otherwise, if no coin toss exists, the next event should be seq=1 (for coin toss)
    // But if coin toss already exists, start from maxBaseSeq + 1
    if (coinTossEvent && Math.floor(coinTossEvent.seq || 0) === 1) {
      return Math.max(2, maxBaseSeq + 1)
    }
    return maxBaseSeq + 1
  }, [matchId])

  // Helper function to get next sub-sequence number for related events (returns decimal like 1.1, 1.2, etc.)
  const getNextSubSeq = useCallback(async (parentSeq) => {
    const allEvents = await db.events.where('matchId').equals(matchId).toArray()
    const baseSeq = Math.floor(parentSeq)
    
    // Find all events with the same base ID (1, 1.1, 1.2, etc.)
    const relatedEvents = allEvents.filter(e => {
      const eSeq = e.seq || 0
      return Math.floor(eSeq) === baseSeq
    })
    
    // Find the highest sub-sequence number for this base ID
    const maxSubSeq = relatedEvents.reduce((max, e) => {
      const eSeq = e.seq || 0
      const eBaseSeq = Math.floor(eSeq)
      if (eBaseSeq === baseSeq && eSeq !== baseSeq) {
        // This is a sub-event (has decimal part)
        const subPart = eSeq - baseSeq // e.g., 1.2 - 1 = 0.2
        return Math.max(max, subPart)
      }
      return max
    }, 0)
    
    // Return next sub-sequence (increment by 0.1)
    return baseSeq + (maxSubSeq + 0.1)
  }, [matchId])

  // Debug functions (available in console)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      // Debug function to export match data as JSON (for testing fillable PDF)
      window.debugExportMatchData = async () => {
        try {
          const allEvents = await db.events.where('matchId').equals(matchId).toArray()
          const allSets = await db.sets.where('matchId').equals(matchId).toArray()
          const allReferees = await db.referees.toArray()
          const allScorers = await db.scorers.toArray()
          
          const matchData = {
            match: data?.match,
            homeTeam: data?.homeTeam,
            awayTeam: data?.awayTeam,
            homePlayers: data?.homePlayers || [],
            awayPlayers: data?.awayPlayers || [],
            sets: allSets,
            events: allEvents,
            referees: allReferees,
            scorers: allScorers
          }
          
          // Log to console
          
          // Also download as file
          const blob = new Blob([JSON.stringify(matchData, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `match-data-${matchId || 'export'}.json`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          URL.revokeObjectURL(url)
          
        } catch (error) {
          console.error('Error exporting match data:', error)
        }
      }

      // Function to generate fillable PDF (simple form filling)
      window.debugGenerateFillablePDF = async () => {
        try {
          const match = data?.match
          if (!match) {
            console.error('No match data available')
            return
          }

          // Prepare match data in the format expected by fillPdfForm
          const fillableData = {
            match_type_1: match.matchType || match.match_type_1 || 'championship',
            match_type_2: match.category || match.match_type_2 || '',
            league: match.league || '',
            gameNumber: match.gameNumber || match.externalId || '',
            homeTeam: data?.homeTeam?.name || '',
            awayTeam: data?.awayTeam?.name || '',
            city: match.city || '',
            hall: match.venue || match.hall || '',
            scheduledAt: match.scheduledAt,
            bench_home: match.bench_home || [],
            bench_away: match.bench_away || [],
            officials: match.officials || []
          }

          await generateFillablePdf(fillableData)
        } catch (error) {
          console.error('Error generating fillable PDF:', error)
        }
      }

      // Debug function to check games in progress
      window.debugCheckGamesInProgress = async () => {
        try {
          console.log('🔍 Checking games from two sources:')
          console.log('   1. Local IndexedDB (current match data)')
          console.log('   2. Server API (what Referee Dashboard sees)')
          console.log('')
          
          // 1. Check local IndexedDB
          const allMatches = await db.matches.toArray()
          const inProgressMatches = allMatches.filter(m => 
            m.status === 'live' || m.status === 'scheduled'
          )
          
          console.log(`📦 Local IndexedDB: ${inProgressMatches.length} match(es)`)
          
          // 2. Check server API (what Referee Dashboard actually uses)
          let serverMatches = []
          try {
            const { listAvailableMatches } = await import('../utils/serverDataSync')
            const serverResult = await listAvailableMatches()
            if (serverResult.success && serverResult.matches) {
              serverMatches = serverResult.matches
            }
          } catch (err) {
            console.warn('⚠️ Could not fetch from server API:', err.message)
          }
          
          console.log(`🌐 Server API: ${serverMatches.length} match(es) available in Referee Dashboard`)
          console.log('')
          
          if (serverMatches.length > 0 && inProgressMatches.length === 0) {
            console.log('⚠️ DISCREPANCY DETECTED!')
            console.log('   Server has matches but local DB does not.')
            console.log('   This means matches exist in server memory but not synced to local DB.')
            console.log('')
          }
          
          // Show server matches (what actually appears in dropdown)
          if (serverMatches.length > 0) {
            console.log('📋 Matches available in Referee Dashboard dropdown:')
            console.table(serverMatches.map(m => ({
              id: m.id,
              gameNumber: m.gameNumber,
              homeTeam: m.homeTeam,
              awayTeam: m.awayTeam,
              status: m.status,
              dateTime: m.dateTime,
              refereeConnectionEnabled: m.refereeConnectionEnabled
            })))
            
            serverMatches.forEach((m, idx) => {
              console.log(`\n🎮 Server Match ${idx + 1}:`)
              console.log(`   ID: ${m.id}`)
              console.log(`   Game #: ${m.gameNumber}`)
              console.log(`   Teams: ${m.homeTeam} vs ${m.awayTeam}`)
              console.log(`   Status: ${m.status}`)
              console.log(`   Date/Time: ${m.dateTime}`)
              console.log(`   Referee Connection: ${m.refereeConnectionEnabled ? '✅ Enabled' : '❌ Disabled'}`)
            })
          }
          
          // Show local DB matches with details
          if (inProgressMatches.length > 0) {
            const matchesWithDetails = await Promise.all(
              inProgressMatches.map(async (match) => {
                const homeTeam = match.homeTeamId ? await db.teams.get(match.homeTeamId) : null
                const awayTeam = match.awayTeamId ? await db.teams.get(match.awayTeamId) : null
                const sets = await db.sets.where('matchId').equals(match.id).toArray()
                const currentSet = sets.find(s => !s.finished) || sets[sets.length - 1]
                const eventCount = await db.events.where('matchId').equals(match.id).count()
                const isCurrentMatch = matchId && String(match.id) === String(matchId)
                
                return {
                  id: match.id,
                  gameNumber: match.gameNumber || match.externalId || 'N/A',
                  homeTeam: homeTeam?.name || 'Unknown',
                  awayTeam: awayTeam?.name || 'Unknown',
                  status: match.status,
                  isLive: match.status === 'live',
                  currentSet: currentSet ? {
                    index: currentSet.index,
                    homePoints: currentSet.homePoints,
                    awayPoints: currentSet.awayPoints
                  } : null,
                  totalSets: sets.length,
                  eventCount: eventCount,
                  refereeConnectionEnabled: match.refereeConnectionEnabled !== false,
                  isCurrentMatch: isCurrentMatch
                }
              })
            )
            
            console.log('\n📦 Local IndexedDB matches:')
            console.table(matchesWithDetails)
            
            matchesWithDetails.forEach((m, idx) => {
              const statusIcon = m.isLive ? '🔴' : '📅'
              console.log(`\n${statusIcon} Local Match ${idx + 1}:${m.isCurrentMatch ? ' (CURRENT)' : ''}`)
              console.log(`   ID: ${m.id}`)
              console.log(`   Game #: ${m.gameNumber}`)
              console.log(`   Teams: ${m.homeTeam} vs ${m.awayTeam}`)
              console.log(`   Status: ${m.status} ${m.isLive ? '(LIVE)' : '(SCHEDULED)'}`)
              if (m.currentSet) {
                console.log(`   Current Set: Set ${m.currentSet.index + 1} - ${m.currentSet.homePoints} - ${m.currentSet.awayPoints}`)
              }
              console.log(`   Total Sets: ${m.totalSets}, Events: ${m.eventCount}`)
            })
          }
          
          return { 
            localDB: { matches: inProgressMatches, count: inProgressMatches.length },
            serverAPI: { matches: serverMatches, count: serverMatches.length }
          }
        } catch (error) {
          console.error('❌ Error checking games in progress:', error)
          return { localDB: { matches: [], count: 0 }, serverAPI: { matches: [], count: 0 }, error: error.message }
        }
      }
    }
    return () => {
      if (typeof window !== 'undefined') {
        if (window.debugExportMatchData) delete window.debugExportMatchData
        if (window.debugGenerateFillablePDF) delete window.debugGenerateFillablePDF
        if (window.debugCheckGamesInProgress) delete window.debugCheckGamesInProgress
      }
    }
  }, [matchId, data?.match, data?.homeTeam, data?.awayTeam, data?.homePlayers, data?.awayPlayers])

  const logEvent = useCallback(
    async (type, payload = {}, options = {}) => {
      if (!data?.set) return null
      
      // If parentSeq is provided, create a sub-event with decimal ID (e.g., 1.1, 1.2)
      // Otherwise, create a main event with integer ID
      let nextSeq
      if (options.parentSeq !== undefined) {
        nextSeq = await getNextSubSeq(options.parentSeq)
      } else {
        nextSeq = await getNextSeq()
      }
      
      // Simple timestamp for reference (not used for ordering)
      const timestamp = options.timestamp ? new Date(options.timestamp) : new Date()
      
      const eventId = await db.events.add({
        matchId,
        setIndex: data.set.index,
        type,
        payload,
        ts: timestamp.toISOString(), // Store as ISO string for reference
        seq: nextSeq // Use sequence for ordering
      })
      
      // Sequence tracking (no logging)
      
      // Get match to check if it's a test match
      const match = await db.matches.get(matchId)
      const isTest = match?.test || false
      
      // Only sync official matches to Supabase, not test matches
      if (!isTest) {
        await db.sync_queue.add({
          resource: 'event',
          action: 'insert',
          payload: {
            match_id: match?.externalId || null,
            set_index: data.set.index,
            type,
            payload,
            test: false
          },
          ts: Date.now(),
          status: 'queued'
        })
      }
      
      // Sync to referee after every event
      syncToReferee()
      
      // Return the sequence number so it can be used for related events
      return nextSeq
    },
    [data?.set, matchId, getNextSeq, syncToReferee]
  )

  const checkSetEnd = useCallback(async (set, homePoints, awayPoints) => {
    // Don't show modal if it's already open
    if (setEndTimeModal) return false

    // Determine if this is the 5th set (tie-break set)
    const is5thSet = set.index === 5
    const pointsToWin = is5thSet ? 15 : 25

    // Check if this point would end the set
    if (homePoints >= pointsToWin && homePoints - awayPoints >= 2) {
      // Close all libero modals
      setLiberoRotationModal(null)
      setLiberoReentryModal(null)
      setLiberoConfirm(null)
      setLiberoDropdown(null)
      setExchangeLiberoDropdown(null)
      
      // Calculate current set scores to determine if this is match-ending
      const allSets = await db.sets.where({ matchId }).toArray()
      const finishedSets = allSets.filter(s => s.finished)
      const homeSetsWon = finishedSets.filter(s => s.homePoints > s.awayPoints).length
      const awaySetsWon = finishedSets.filter(s => s.awayPoints > s.homePoints).length
      
      // If home wins this set, will they have 3 sets?
      const isMatchEnd = (homeSetsWon + 1) >= 3
      
      // Show set end time confirmation modal
      const defaultTime = new Date().toISOString()
      setSetEndTimeModal({ setIndex: set.index, winner: 'home', homePoints, awayPoints, defaultTime, isMatchEnd })
      return true
    }
    if (awayPoints >= pointsToWin && awayPoints - homePoints >= 2) {
      // Close all libero modals
      setLiberoRotationModal(null)
      setLiberoReentryModal(null)
      setLiberoConfirm(null)
      setLiberoDropdown(null)
      setExchangeLiberoDropdown(null)
      
      // Calculate current set scores to determine if this is match-ending
      const allSets = await db.sets.where({ matchId }).toArray()
      const finishedSets = allSets.filter(s => s.finished)
      const homeSetsWon = finishedSets.filter(s => s.homePoints > s.awayPoints).length
      const awaySetsWon = finishedSets.filter(s => s.awayPoints > s.homePoints).length
      
      // If away wins this set, will they have 3 sets?
      const isMatchEnd = (awaySetsWon + 1) >= 3
      
      // Show set end time confirmation modal
      const defaultTime = new Date().toISOString()
      setSetEndTimeModal({ setIndex: set.index, winner: 'away', homePoints, awayPoints, defaultTime, isMatchEnd })
      return true
    }
    return false
  }, [matchId, setEndTimeModal])

  // Determine who has serve based on events
  const getCurrentServe = useCallback(() => {
    if (!data?.set || !data?.match) {
      return data?.match?.firstServe || 'home'
    }
    
    // For set 5, use set5FirstServe if specified
    if (data.set.index === 5 && data.match?.set5FirstServe) {
      const teamAKey = data.match.coinTossTeamA || 'home'
      const teamBKey = data.match.coinTossTeamB || 'away'
      const firstServeTeamKey = data.match.set5FirstServe === 'A' ? teamAKey : teamBKey
      
      if (!data?.events || data.events.length === 0) {
        return firstServeTeamKey
      }
      
      // Find the last point event in the current set to determine serve
      const pointEvents = data.events
        .filter(e => e.type === 'point' && e.setIndex === data.set.index)
        .sort((a, b) => {
          const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
          const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
          return bTime - aTime // Most recent first
        })
      
      if (pointEvents.length === 0) {
        return firstServeTeamKey
      }
      
      // The team that scored the last point now has serve
      const lastPoint = pointEvents[0]
      return lastPoint.payload?.team || firstServeTeamKey
    }
    
    if (!data?.events || data.events.length === 0) {
      // First rally: use firstServe from match
      return data.match.firstServe || 'home'
    }
    
    // Find the last point event in the current set to determine serve
    const pointEvents = data.events
      .filter(e => e.type === 'point' && e.setIndex === data.set.index)
      .sort((a, b) => {
        const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
        const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
        return bTime - aTime // Most recent first
      })
    
    if (pointEvents.length === 0) {
      // No points yet, use firstServe
      return data.match.firstServe || 'home'
    }
    
    // The team that scored the last point now has serve
    const lastPoint = pointEvents[0]
    return lastPoint.payload?.team || data.match.firstServe || 'home'
  }, [data?.events, data?.set, data?.match, data?.match?.set5FirstServe])

  const leftServeTeamKey = leftIsHome ? 'home' : 'away'
  const rightServeTeamKey = leftIsHome ? 'away' : 'home'
  
  // Before coin toss or before set starts, show serve on left (home) as placeholder
  const isBeforeCoinToss = !data?.match?.coinTossTeamA || !data?.match?.coinTossTeamB
  const hasNoSet = !data?.set
  
  const currentServeTeam = data?.set ? getCurrentServe() : null
  
  // Show serve on left as placeholder before coin toss or before set starts
  const leftServing = (isBeforeCoinToss || hasNoSet) 
    ? true // Placeholder: serve on left (home) before coin toss
    : (data?.set ? currentServeTeam === leftServeTeamKey : false)
  const rightServing = (isBeforeCoinToss || hasNoSet) 
    ? false 
    : (data?.set ? currentServeTeam === rightServeTeamKey : false)

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
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', ...style }}>
        {/* Wrapper with ball on left/right OUTSIDE the score container */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Left ball - visible when left team is serving */}
          <div style={{ width: 32, height: 32, flexShrink: 0 }}>
            {leftServing && (
              <img
                src={mikasaVolleyball}
                alt="Serving team"
                style={{
                  ...serveBallBaseStyle,
                  width: 32,
                  height: 32
                }}
              />
            )}
          </div>
          
          {/* Score display container */}
          <div
            className="set-score-display"
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '5px 16px'
            }}
          >
            {/* Left side: score - FIXED width to prevent colon movement */}
            <div style={{ width: 100, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '90px', textAlign: 'right' }}>{pointsBySide.left}</span>
            </div>
            {/* Center colon - fixed width to stay centered */}
            <span style={{ width: 30, textAlign: 'center', flexShrink: 0 }}>:</span>
            {/* Right side: score - FIXED width to prevent colon movement */}
            <div style={{ width: 100, display: 'flex', alignItems: 'center', justifyContent: 'flex-start' }}>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '90px', textAlign: 'left' }}>{pointsBySide.right}</span>
            </div>
          </div>
          
          {/* Right ball - visible when right team is serving */}
          <div style={{ width: 32, height: 32, flexShrink: 0 }}>
            {rightServing && (
              <img
                src={mikasaVolleyball}
                alt="Serving team"
                style={{
                  ...serveBallBaseStyle,
                  width: 32,
                  height: 32
                }}
              />
            )}
          </div>
        </div>
      </div>
    ),
    [leftServing, rightServing, pointsBySide.left, pointsBySide.right, serveBallBaseStyle]
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
    async (side, skipConfirmation = false) => {
      if (!data?.set) return
      const teamKey = mapSideToTeamKey(side)

      // Check for accidental point award (if enabled and rally just started)
      if (checkAccidentalPointAward && !skipConfirmation && rallyStartTimeRef.current) {
        const timeSinceRallyStart = (Date.now() - rallyStartTimeRef.current) / 1000
        if (timeSinceRallyStart < accidentalPointAwardDuration) {
          setAccidentalPointConfirmModal({
            team: teamKey,
            onConfirm: () => {
              setAccidentalPointConfirmModal(null)
              handlePoint(side, true) // Call with skipConfirmation = true
            }
          })
          return
        }
      }
      const field = teamKey === 'home' ? 'homePoints' : 'awayPoints'
      const newPoints = data.set[field] + 1
      const homePoints = teamKey === 'home' ? newPoints : data.set.homePoints
      const awayPoints = teamKey === 'away' ? newPoints : data.set.awayPoints

      // Check who has serve BEFORE this point by querying database directly
      // The team that scored the last point has serve, so check the last point in DB
      const allEventsBeforePoint = await db.events
        .where('matchId')
        .equals(matchId)
        .toArray()
      const pointEventsBefore = allEventsBeforePoint
        .filter(e => e.type === 'point' && e.setIndex === data.set.index)
        .sort((a, b) => {
          const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
          const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
          return bTime - aTime // Most recent first
        })
      
      let serveBeforePoint = data?.match?.firstServe || 'home'
      if (pointEventsBefore.length > 0) {
        // The last point event shows who has serve now (before this new point)
        const lastPoint = pointEventsBefore[0] // Most recent is first after sorting
        serveBeforePoint = lastPoint.payload?.team || serveBeforePoint
      }
      
      const scoringTeamHadServe = serveBeforePoint === teamKey

      // Update score and log point FIRST
      await db.sets.update(data.set.id, {
        [field]: newPoints
      })
      const pointSeq = await logEvent('point', { team: teamKey })

      // Track when point was awarded (for accidental rally start check)
      lastPointAwardedTimeRef.current = Date.now()
      // Reset rally start time since rally ended
      rallyStartTimeRef.current = null

      // If scoring team didn't have serve, they rotate their lineup AFTER the point
      if (!scoringTeamHadServe) {
        // Query database directly for the most recent lineup (data.events might be stale)
        const allLineupEvents = await db.events
          .where('matchId')
          .equals(matchId)
          .toArray()
        const teamLineupEvents = allLineupEvents
          .filter(e => e.type === 'lineup' && e.payload?.team === teamKey && e.setIndex === data.set.index)
          .sort((a, b) => new Date(b.ts) - new Date(a.ts)) // Most recent first
        
        let currentLineup = null
        let liberoSubstitution = null
        
        if (teamLineupEvents.length > 0) {
          // Use the most recent lineup
          const lastLineupEvent = teamLineupEvents[0]
          currentLineup = lastLineupEvent.payload?.lineup
          liberoSubstitution = lastLineupEvent?.payload?.liberoSubstitution
        }
        
        if (currentLineup) {
          
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
              // Query database directly for lineup events (data.events might be stale)
              const allLineupEventsForLibero = await db.events
                .where('matchId')
                .equals(matchId)
                .toArray()
              const allLineupEvents = allLineupEventsForLibero
                .filter(e => 
                  e.type === 'lineup' && 
                  e.payload?.team === teamKey && 
                  e.setIndex === data.set.index
                )
                .sort((a, b) => new Date(b.ts) - new Date(a.ts)) // Most recent first
              
              let originalPlayerNumber = null
              
              // First, try to use the rotated libero substitution if the libero matches
              // The position in rotatedLiberoSubstitution is the NEW position after rotation
              // But we need to check if this libero is the one in the front row position
              if (rotatedLiberoSubstitution && 
                  String(rotatedLiberoSubstitution.liberoNumber) === String(liberoNumber)) {
                // Check if this is the same libero (regardless of position match, since position was rotated)
                originalPlayerNumber = rotatedLiberoSubstitution.playerNumber
              } else {
                // If rotatedLiberoSubstitution doesn't match, search for the original libero substitution
                // We need to find the libero substitution BEFORE rotation to get the original player
                for (const event of allLineupEvents) {
                  if (event.payload?.liberoSubstitution && 
                      String(event.payload.liberoSubstitution.liberoNumber) === String(liberoNumber)) {
                    // Found the libero substitution - use the original player
                    originalPlayerNumber = event.payload.liberoSubstitution.playerNumber
                    break
                  }
                }
                
                // If still not found, we need to find who was in the PRE-ROTATION position
                // The current position is AFTER rotation, so we need to reverse the rotation
                // to find who was there before rotation
                if (!originalPlayerNumber) {
                  // Reverse rotation map: if libero is now in position X after rotation,
                  // they were in position Y before rotation, where Y rotates to X
                  // Rotation: II→I, III→II, IV→III, V→IV, VI→V, I→VI
                  // Reverse: I→II, II→III, III→IV, IV→V, V→VI, VI→I
                  const reversePositionMap = {
                    'I': 'II',
                    'II': 'III',
                    'III': 'IV',
                    'IV': 'V',
                    'V': 'VI',
                    'VI': 'I'
                  }
                  const preRotationPosition = reversePositionMap[position]
                  
                  // Now find who was in the pre-rotation position before the libero entered
                for (const event of allLineupEvents) {
                  const lineup = event.payload?.lineup
                    if (lineup && lineup[preRotationPosition]) {
                      const playerNum = lineup[preRotationPosition]
                    const player = teamPlayers?.find(p => String(p.number) === String(playerNum))
                      // If this position had a non-libero player, and it's not the libero, use it
                      if (player && (!player.libero || player.libero === '') && 
                          String(playerNum) !== String(liberoNumber)) {
                        // But check if this player is already in the rotated lineup
                        let playerAlreadyInRotatedLineup = false
                        for (const [pos, num] of Object.entries(rotatedLineup)) {
                          if (String(num) === String(playerNum)) {
                            playerAlreadyInRotatedLineup = true
                      break
                    }
                        }
                        if (!playerAlreadyInRotatedLineup) {
                          originalPlayerNumber = Number(playerNum)
                      break
                        }
                      }
                    }
                  }
                }
              }
              
              // If we found the original player, restore them
              if (originalPlayerNumber) {
                // Check if the original player is already in the rotated lineup in another position
                // If so, we should NOT restore them (they're already on court in their rotated position)
                let originalPlayerAlreadyOnCourt = false
                for (const [pos, playerNum] of Object.entries(rotatedLineup)) {
                  if (pos !== position && String(playerNum) === String(originalPlayerNumber)) {
                    // The original player is already in another position after rotation
                    // This means they rotated to a different position, so we should NOT restore them here
                    originalPlayerAlreadyOnCourt = true
                    break
                  }
                }
                
                if (originalPlayerAlreadyOnCourt) {
                  // The original player is already on court in another position
                  // Just remove the libero and leave the position empty (or find who should be there)
                  // Actually, if the original player rotated to another position, we need to find
                  // who should be in this position after rotation
                  // For now, just remove the libero - the position will be empty
                  rotatedLineup[position] = ''
                  rotatedLiberoSubstitution = null
                } else {
                  // Original player is not on court, safe to restore them
                rotatedLineup[position] = String(originalPlayerNumber)
                rotatedLiberoSubstitution = null // Clear libero substitution since libero is out
                }
                
                // Store info about the libero that was removed
                const liberoPlayer = teamPlayers?.find(p => String(p.number) === String(liberoNumber))
                liberoExitedInfo = {
                  liberoNumber: Number(liberoNumber),
                  liberoType: liberoPlayer?.libero,
                  originalPlayerNumber: originalPlayerNumber
                }
                
                // Show modal that libero must go out (if option enabled)
                if (liberoExitConfirmation) {
                  setLiberoRotationModal({
                    team: teamKey,
                    position: position,
                    liberoNumber: Number(liberoNumber),
                    playerNumber: originalPlayerNumber,
                    liberoType: liberoPlayer?.libero
                  })
                }
                
                // Log libero exit (after point, so use point relative time + 2ms)
                // Use decimal ID based on the point's action ID (e.g., if point is 1, libero_exit is 1.2)
                await logEvent('libero_exit', {
                  team: teamKey,
                  position: position,
                  liberoOut: liberoNumber,
                  playerIn: originalPlayerNumber,
                  liberoType: liberoPlayer?.libero,
                  reason: 'rotation_to_front_row'
                }, { parentSeq: pointSeq })
                
                // Check if the libero leaving is the court captain
                const captainOnCourtField = teamKey === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain'
                const currentCourtCaptain = data?.match?.[captainOnCourtField]
                if (currentCourtCaptain === liberoNumber) {
                  setTimeout(() => {
                    checkAndRequestCaptainOnCourt(teamKey)
                  }, 100)
                }
              } else {
                // Fallback: if we can't find the original player, remove the libero anyway - they can't be in front row
                rotatedLineup[position] = ''
                rotatedLiberoSubstitution = null
              }
            }
            
            // Ensure rotated lineup only has exactly 6 positions (defensive check)
            const validPositions = ['I', 'II', 'III', 'IV', 'V', 'VI']
            const cleanedRotatedLineup = {}
            for (const pos of validPositions) {
              if (rotatedLineup[pos] !== undefined) {
                cleanedRotatedLineup[pos] = rotatedLineup[pos]
              }
            }
            
            // Save the rotated lineup as a new lineup event (but don't log it - it's automatic rotation)
            // Use decimal ID based on the point's action ID (e.g., if point is 1, rotation is 1.1)
            const rotationSeq = await getNextSubSeq(pointSeq)
            const rotationEventId = await db.events.add({
              matchId,
              setIndex: data.set.index,
              type: 'lineup',
              payload: { 
                team: teamKey, 
                lineup: cleanedRotatedLineup,
                liberoSubstitution: rotatedLiberoSubstitution // Include rotated libero substitution if it exists
              },
              ts: new Date().toISOString(),
              seq: rotationSeq // Decimal ID for ordering (e.g., 1.1)
            })
            // Don't add to sync_queue for rotation lineups
            // But sync to referee so they see the updated lineup after rotation
            syncToReferee()
          }
        }
      }
      
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
              // Get all liberos for this team
              const teamPlayers = otherTeamKey === 'home' ? data.homePlayers : data.awayPlayers
              const teamLiberos = teamPlayers?.filter(p => p.libero && p.libero !== '' && !isLiberoUnable(otherTeamKey, p.number)) || []

              // Build available liberos list
              const availableLiberos = teamLiberos.map(libero => ({
                number: libero.number,
                type: libero.libero,
                label: libero.libero === 'libero1' ? 'L1' : 'L2'
              }))

              // Find which libero was last on court (default selection)
              const defaultLiberoIndex = availableLiberos.findIndex(l => l.number === Number(liberoNumber) && l.type === liberoType)

              // Ask if they want to put a libero back in at position I (if option enabled)
              if (liberoEntrySuggestion) {
                setLiberoReentryModal({
                  team: otherTeamKey,
                  position: 'I',
                  playerNumber: Number(playerInI),
                  liberoNumber: Number(liberoNumber),
                  liberoType: liberoType,
                  availableLiberos: availableLiberos,
                  selectedLiberoIndex: defaultLiberoIndex >= 0 ? defaultLiberoIndex : 0
                })
              }
            }
          }
        }
      }
      
      // Check for 5th set court switch at 8 points
      // Only check if the team that JUST SCORED has reached 8 (not if either team has 8)
      const is5thSet = data.set.index === 5
      const scoringTeamPoints = teamKey === 'home' ? homePoints : awayPoints
      if (is5thSet && scoringTeamPoints === 8) {
        // Check if we've already switched courts in this set
        const hasSwitchedCourts = await db.matches.get(matchId).then(m => m?.set5CourtSwitched || false)
        
        if (!hasSwitchedCourts) {
          // Show court switch modal
          setCourtSwitchModal({
            set: data.set,
            homePoints,
            awayPoints,
            teamThatScored: teamKey
          })
          return // Don't check for set end yet, wait for court switch confirmation
        }
      }
      
      const setEnded = checkSetEnd(data.set, homePoints, awayPoints)
      // If set didn't end, we're done. If it did, checkSetEnd will show the confirmation modal
    },
    [data?.set, data?.events, logEvent, mapSideToTeamKey, checkSetEnd, getCurrentServe, rotateLineup, matchId, syncToReferee]
  )

  const handleStartRally = useCallback(async (skipConfirmation = false) => {
    // Check for accidental rally start (if enabled and point was just awarded)
    if (checkAccidentalRallyStart && !skipConfirmation && lastPointAwardedTimeRef.current) {
      const timeSinceLastPoint = (Date.now() - lastPointAwardedTimeRef.current) / 1000
      if (timeSinceLastPoint < accidentalRallyStartDuration) {
        setAccidentalRallyConfirmModal({
          onConfirm: () => {
            setAccidentalRallyConfirmModal(null)
            handleStartRally(true) // Call with skipConfirmation = true
          }
        })
        return
      }
    }

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
    // Track when rally started (for accidental point award check)
    rallyStartTimeRef.current = Date.now()
  }, [logEvent, isFirstRally, data?.homePlayers, data?.awayPlayers, data?.events, data?.set, data?.match, matchId, getNextSubSeq, syncToReferee, checkAccidentalRallyStart, accidentalRallyStartDuration])

  const handleReplay = useCallback(async () => {
    // During rally: just log replay event (no point to undo)
    if (rallyStatus === 'in_play') {
      await logEvent('replay')
      return
    }
    // After point: show confirmation modal to undo point
    if (rallyStatus === 'idle' && canReplayRally && data?.events) {
      // Find the last event by sequence number (highest seq)
      const allEvents = [...data.events].sort((a, b) => {
        const aSeq = a.seq || 0
        const bSeq = b.seq || 0
        if (aSeq !== 0 || bSeq !== 0) {
          return bSeq - aSeq // Descending
        }
        const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
        const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
        return bTime - aTime
      })

      const lastEvent = allEvents[0]
      if (lastEvent && lastEvent.type === 'point') {
        // Simple description for replay confirmation
        const teamName = lastEvent.payload?.team === 'home'
          ? (data?.homeTeam?.name || 'Home')
          : (data?.awayTeam?.name || 'Away')
        const description = `Point for ${teamName}`
        setReplayRallyConfirm({ event: lastEvent, description })
      }
    }
  }, [logEvent, rallyStatus, canReplayRally, data?.events, data?.homeTeam?.name, data?.awayTeam?.name])

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

  // Handle team sanction (for smartphone mode) - takes team key instead of side
  const handleTeamSanction = useCallback((teamKey, sanctionType) => {
    if (!data?.match || rallyStatus !== 'idle') return
    // Convert team key to side
    const side = (teamKey === 'home' && leftIsHome) || (teamKey === 'away' && !leftIsHome) ? 'left' : 'right'
    setSanctionConfirm({ side, type: sanctionType })
  }, [data?.match, rallyStatus, leftIsHome])

  // Confirm sanction
  const confirmSanction = useCallback(async () => {
    if (!sanctionConfirm || !data?.match || !data?.set) return
    
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
    
    // If delay penalty, award point to the other team (but only if lineups are set)
    if (type === 'delay_penalty') {
      // Check if both lineups are set before awarding point
      const homeLineupSet = data.events?.some(e => 
        e.type === 'lineup' && 
        e.payload?.team === 'home' && 
        e.setIndex === data.set.index &&
        e.payload?.isInitial
      )
      const awayLineupSet = data.events?.some(e => 
        e.type === 'lineup' && 
        e.payload?.team === 'away' && 
        e.setIndex === data.set.index &&
        e.payload?.isInitial
      )
      
      setSanctionConfirm(null)
      
      if (homeLineupSet && awayLineupSet) {
        // Both lineups are set - award point immediately
        const otherSide = side === 'left' ? 'right' : 'left'
        await handlePoint(otherSide)
      } else {
        // Lineups not set - show message
        alert('Delay penalty recorded. Point will be awarded after both teams set their lineups.')
      }
    } else {
      setSanctionConfirm(null)
    }
  }, [sanctionConfirm, data?.match, data?.set, data?.events, mapSideToTeamKey, matchId, logEvent, handlePoint])

  // Confirm set start time
  const confirmSetStartTime = useCallback(async (time) => {
    if (!setStartTimeModal || !data?.set) return
    
    // Update set with start time (absolute timestamp)
    await db.sets.update(data.set.id, { startTime: time })
    
    // Get the highest sequence number for this match
    const nextSeq1 = await getNextSeq()
    const nextSeq2 = nextSeq1 + 1
    
    // Log set_start event
    const setStartEventId = await db.events.add({
      matchId,
      setIndex: data.set.index,
      type: 'set_start',
      payload: {
        setIndex: setStartTimeModal.setIndex,
        startTime: time
      },
      ts: time,
      seq: nextSeq1
    })

    setSetStartTimeModal(null)

    // Now actually start the rally
    await db.events.add({
      matchId,
      setIndex: data.set.index,
      type: 'rally_start',
      payload: {},
      ts: new Date().toISOString(),
      seq: nextSeq2
    })
  }, [setStartTimeModal, data?.set, matchId])

  // Confirm set end time
  const confirmSetEndTime = useCallback(async (time) => {
    if (!setEndTimeModal || !data?.match || !data?.set) return

    const { setIndex, winner, homePoints, awayPoints } = setEndTimeModal

    // Close modal immediately to prevent multiple confirmations
    setSetEndTimeModal(null)

    // Determine team labels (A or B) based on coin toss
    const teamAKey = data.match.coinTossTeamA || 'home'
    const winnerLabel = winner === 'home'
      ? (teamAKey === 'home' ? 'A' : 'B')
      : (teamAKey === 'away' ? 'A' : 'B')

    // Get start time from current set
    const startTime = data.set.startTime

    // Log set win with start and end times
    await logEvent('set_end', {
      team: winner,
      teamLabel: winnerLabel,
      setIndex: setIndex,
      homePoints,
      awayPoints,
      startTime: startTime,
      endTime: time
    })

    // Update set with end time and finished status
    await db.sets.update(data.set.id, { finished: true, homePoints, awayPoints, endTime: time })

    // Get all sets and calculate sets won by each team
    const sets = await db.sets.where({ matchId }).toArray()
    const finishedSets = sets.filter(s => s.finished)
    const homeSetsWon = finishedSets.filter(s => s.homePoints > s.awayPoints).length
    const awaySetsWon = finishedSets.filter(s => s.awayPoints > s.homePoints).length
    
    // Check if either team has won 3 sets (match win)
    const isMatchEnd = homeSetsWon >= 3 || awaySetsWon >= 3
    
    if (isMatchEnd) {
      // IMPORTANT: When match ends, preserve ALL data in database:
      // - All sets remain in db.sets
      // - All events remain in db.events
      // - All players remain in db.players
      // - All teams remain in db.teams
      // - Only update match status to 'final' - DO NOT DELETE ANYTHING
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
      
      // Notify server to delete match from matchDataStore (since it's now final)
      const currentWs = wsRef.current
      if (currentWs && currentWs.readyState === WebSocket.OPEN) {
        try {
          currentWs.send(JSON.stringify({
            type: 'delete-match',
            matchId: String(matchId)
          }))
        } catch (err) {
          // Silently ignore WebSocket errors
        }
      }

      // Only call onFinishSet for match end, not between sets
      // (Scoreboard now handles set creation internally)
      if (onFinishSet) onFinishSet(data.set)
    } else {
      // Start countdown immediately when set ends (not match end)
      // Reset dismissed flag and start countdown
      countdownDismissedRef.current = false
      setBetweenSetsCountdown({ countdown: setIntervalDuration, started: true })

      // Send set_end action to referee to show countdown
      sendActionToReferee('set_end', {
        setIndex,
        winner: winner,
        homePoints: homePoints,
        awayPoints: awayPoints,
        countdown: setIntervalDuration
      })

      // If set 4 just ended, show modal to choose sides and service for set 5
      if (setIndex === 4) {
        // Close the set end time modal first
        setSetEndTimeModal(null)

        // Get team A/B assignments for set 5 modal (use local scope to avoid reference errors)
        const set4TeamAKey = data.match.coinTossTeamA || 'home'
        const set4TeamBKey = data.match.coinTossTeamB || 'away'

        // Determine current positions at end of set 4 (set 2, 3, 4 have teams switched)
        const set4LeftIsHome = set4TeamAKey !== 'home'
        const set4LeftTeamKey = set4LeftIsHome ? 'home' : 'away'
        const set4RightTeamKey = set4LeftIsHome ? 'away' : 'home'
        const set4LeftTeamLabel = set4LeftTeamKey === set4TeamAKey ? 'A' : 'B'
        const set4RightTeamLabel = set4RightTeamKey === set4TeamAKey ? 'A' : 'B'

        // Get current serve at end of set 4
        const currentServe = getCurrentServe()
        const set4ServingTeamKey = currentServe
        const set4ServingTeamLabel = set4ServingTeamKey === set4TeamAKey ? 'A' : 'B'
        
        // Use existing values if set, otherwise use current positions
        const selectedLeftTeam = data.match?.set5LeftTeam || set4LeftTeamLabel
        const selectedFirstServe = data.match?.set5FirstServe || set4ServingTeamLabel
        
        // Use setTimeout to ensure setEndTimeModal closes before showing set5 modal
        setTimeout(() => {
          setSet5SelectedLeftTeam(selectedLeftTeam)
          setSet5SelectedFirstServe(selectedFirstServe)
          setSet5SideServiceModal({ 
            setIndex: setIndex + 1,
            set4LeftTeamLabel,
            set4RightTeamLabel,
            set4ServingTeamLabel
          })
        }, 100)
        return
      }
      
      const newSetIndex = setIndex + 1

      // Check if a set with this index already exists to prevent duplicates
      const existingSet = await db.sets.where({ matchId, index: newSetIndex }).first()
      console.log('[Set Transition] Creating set', newSetIndex, 'for match', matchId, 'existingSet:', existingSet)
      if (existingSet) {
        console.log('[Set Transition] Set already exists, returning existing id:', existingSet.id)
        return existingSet.id
      }

      const newSetId = await db.sets.add({
        matchId,
        index: newSetIndex,
        homePoints: 0,
        awayPoints: 0,
        finished: false
      })
      console.log('[Set Transition] Created new set with id:', newSetId)

      // Get match to determine first serve for the new set
      const match = await db.matches.get(matchId)
      const coinTossFirstServe = match?.firstServe || 'home' // Original first serve from coin toss
      const teamAKey = match?.coinTossTeamA || 'home'
      const teamBKey = match?.coinTossTeamB || 'away'
      
      // Determine first serve based on set number (except set 5 which has its own logic)
      // The coin toss determines who serves first in set 1, then it alternates
      // Set 1: Coin toss winner serves, Set 2: Coin toss winner receives, Set 3: Coin toss winner serves, Set 4: Coin toss winner receives
      let newFirstServe = 'home'
      if (newSetIndex !== 5) {
        // For sets 1-4: odd sets (1, 3) = coin toss winner serves, even sets (2, 4) = opposite serves
        const oppositeTeam = coinTossFirstServe === 'home' ? 'away' : 'home'
        newFirstServe = newSetIndex % 2 === 1 ? coinTossFirstServe : oppositeTeam
      } else {
        // Set 5 uses set5FirstServe if specified, otherwise keep current firstServe
        if (match?.set5FirstServe) {
          newFirstServe = match.set5FirstServe === 'A' ? teamAKey : teamBKey
        } else {
          newFirstServe = match?.firstServe || coinTossFirstServe
        }
      }
      
      // Update match with new first serve and reset set5CourtSwitched flag
      await db.matches.update(matchId, { 
        firstServe: newFirstServe,
        set5CourtSwitched: false 
      })
      
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
  }, [setEndTimeModal, data?.match, data?.set, matchId, logEvent, onFinishSet, getCurrentServe, teamAKey])

  // Confirm set 5 side and service choices
  const confirmSet5SideService = useCallback(async (leftTeam, firstServe) => {
    if (!set5SideServiceModal || !data?.match) return

    const { setIndex } = set5SideServiceModal
    const teamAKey = data.match.coinTossTeamA || 'home'
    const teamBKey = data.match.coinTossTeamB || 'away'

    // Determine which team (home/away) is on the left
    const leftTeamKey = leftTeam === 'A' ? teamAKey : teamBKey

    // Determine which team (home/away) serves first
    const firstServeTeamKey = firstServe === 'A' ? teamAKey : teamBKey

    console.log('[Set 5 Coin Toss] Confirming set 5 configuration:', { leftTeam, firstServe, setIndex })

    // Update match with set 5 configuration and first serve
    await db.matches.update(matchId, {
      set5LeftTeam: leftTeam,
      set5FirstServe: firstServe,
      firstServe: firstServeTeamKey,
      set5CourtSwitched: false
    })

    // Create set 5 (check if already exists first)
    const existingSet5 = await db.sets.where({ matchId, index: setIndex }).first()
    let newSetId
    if (existingSet5) {
      console.log('[Set 5 Coin Toss] Set 5 already exists with id:', existingSet5.id)
      // Make sure it's not marked as finished (in case of redo)
      await db.sets.update(existingSet5.id, { finished: false, homePoints: 0, awayPoints: 0 })
      newSetId = existingSet5.id
    } else {
      newSetId = await db.sets.add({
        matchId,
        index: setIndex,
        homePoints: 0,
        awayPoints: 0,
        finished: false
      })
      console.log('[Set 5 Coin Toss] Created new set 5 with id:', newSetId)
    }

    // Log the set 5 coin toss event so it can be undone
    const nextSeq = await getNextSeq()
    await db.events.add({
      matchId,
      setIndex: setIndex,
      type: 'set5_coin_toss',
      payload: {
        leftTeam,
        firstServe,
        leftTeamKey,
        firstServeTeamKey
      },
      ts: new Date().toISOString(),
      seq: nextSeq
    })

    // Get match to check if it's a test match
    const match = await db.matches.get(matchId)
    const isTest = match?.test || false

    // Only add to sync queue if set was newly created
    if (!existingSet5) {
      await db.sync_queue.add({
        resource: 'set',
        action: 'insert',
        payload: {
          external_id: String(newSetId),
          match_id: match?.externalId || String(matchId),
          index: setIndex,
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

    setSet5SideServiceModal(null)
  }, [set5SideServiceModal, data?.match, matchId, getNextSeq])

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
    if (event.type === 'coin_toss') {
      const teamA = event.payload?.teamA === 'home' ? (data?.homeTeam?.name || 'Home') : (data?.awayTeam?.name || 'Away')
      const teamB = event.payload?.teamB === 'home' ? (data?.homeTeam?.name || 'Home') : (data?.awayTeam?.name || 'Away')
      const firstServeTeam = event.payload?.firstServe === 'home' ? teamA : teamB
      eventDescription = `Coin toss — Team A: ${teamA}, Team B: ${teamB}, First serve: ${firstServeTeam}`
    } else if (event.type === 'point') {
      eventDescription = `Point — ${teamName} (${homeLabel} ${homeScore}:${awayScore} ${awayLabel})`
    } else if (event.type === 'timeout') {
      eventDescription = `Timeout — ${teamName}`
    } else if (event.type === 'substitution') {
      const playerOut = event.payload?.playerOut || '?'
      const playerIn = event.payload?.playerIn || '?'
      const isExceptional = event.payload?.isExceptional === true
      const substitutionType = isExceptional ? 'Exceptional substitution' : 'Substitution'
      eventDescription = `${substitutionType} — ${teamName} (OUT: ${playerOut} IN: ${playerIn}) (${homeLabel} ${homeScore}:${awayScore} ${awayLabel})`
    } else if (event.type === 'set_start') {
      // Format the relative time as MM:SS
      const relativeTime = typeof event.ts === 'number' ? event.ts : 0
      const totalSeconds = Math.floor(relativeTime / 1000)
      const minutes = Math.floor(totalSeconds / 60)
      const seconds = totalSeconds % 60
      const minutesStr = String(minutes).padStart(2, '0')
      const secondsStr = String(seconds).padStart(2, '0')
      eventDescription = `Set start — ${minutesStr}:${secondsStr}`
    } else if (event.type === 'rally_start') {
      eventDescription = 'Rally started'
    } else if (event.type === 'replay') {
      eventDescription = 'Rally replayed'
    } else if (event.type === 'lineup') {
      // Only show initial lineups, not rotation lineups or libero substitution lineups
      const isInitial = event.payload?.isInitial === true
      const hasSubstitution = event.payload?.fromSubstitution === true
      const hasLiberoSub = event.payload?.liberoSubstitution !== null && event.payload?.liberoSubstitution !== undefined
      
      // Skip rotation lineups (they're part of the point)
      if (!isInitial && !hasSubstitution && !hasLiberoSub) {
        return null
      }
      
      // Skip lineup events that have a corresponding libero_entry/exit event (they're redundant)
      if (hasLiberoSub && !isInitial && !hasSubstitution) {
        // Check if there's a libero_entry or libero_exit event with the same or higher seq
        const eventSeq = event.seq || 0
        const allEvents = data.events || []
        const hasCorrespondingLiberoEvent = allEvents.some(e => 
          (e.type === 'libero_entry' || e.type === 'libero_exit') && 
          (e.seq || 0) >= eventSeq &&
          (e.seq || 0) <= eventSeq + 1 // Should be right after
        )
        if (hasCorrespondingLiberoEvent) {
          return null // Skip this lineup event
        }
      }
      
      // Only show initial lineups as "Line-up setup"
      if (isInitial) {
        eventDescription = `Line-up setup — ${teamName}`
      } else {
        return null // Skip non-initial lineups (they're either rotations or redundant)
      }
    } else if (event.type === 'libero_entry') {
      const liberoNumber = event.payload?.liberoIn || '?'
      const playerOut = event.payload?.playerOut || '?'
      const liberoType = event.payload?.liberoType === 'libero1' ? 'L1' : 'L2'
      eventDescription = `Libero entry — ${teamName} (${liberoType} ${liberoNumber} in for ${playerOut})`
    } else if (event.type === 'libero_exit') {
      const liberoNumber = event.payload?.liberoOut || '?'
      const playerIn = event.payload?.playerIn || '?'
      const liberoType = event.payload?.liberoType === 'libero1' ? 'L1' : 'L2'
      eventDescription = `Libero exit — ${teamName} (${liberoType} ${liberoNumber} out, ${playerIn} in)`
    } else if (event.type === 'libero_exchange') {
      const liberoOut = event.payload?.liberoOut || '?'
      const liberoIn = event.payload?.liberoIn || '?'
      const liberoOutType = event.payload?.liberoOutType === 'libero1' ? 'L1' : 'L2'
      const liberoInType = event.payload?.liberoInType === 'libero1' ? 'L1' : 'L2'
      eventDescription = `Libero substitution — ${teamName} (${liberoOutType} ${liberoOut} ↔ ${liberoInType} ${liberoIn})`
    } else if (event.type === 'libero_unable') {
      const liberoNumber = event.payload?.liberoNumber || '?'
      const liberoType = event.payload?.liberoType === 'libero1' ? 'L1' : 'L2'
      const reason = event.payload?.reason || 'declared'
      if (reason === 'declared') {
        eventDescription = `Libero declared unable — ${teamName} (${liberoType} ${liberoNumber})`
      } else if (reason === 'injury') {
        eventDescription = `Libero became unable — ${teamName} (${liberoType} ${liberoNumber} - injury)`
      } else if (reason === 'expulsion') {
        eventDescription = `Libero became unable — ${teamName} (${liberoType} ${liberoNumber} - expelled)`
      } else if (reason === 'disqualification') {
        eventDescription = `Libero became unable — ${teamName} (${liberoType} ${liberoNumber} - disqualified)`
      } else {
        eventDescription = `Libero became unable — ${teamName} (${liberoType} ${liberoNumber})`
      }
    } else if (event.type === 'set_end') {
      const winnerLabel = event.payload?.teamLabel || '?'
      const setIndex = event.payload?.setIndex || event.setIndex || '?'
      const startTime = event.payload?.startTime
      const endTime = event.payload?.endTime

      let timeInfo = ''
      if (startTime && endTime) {
        const start = new Date(startTime)
        const end = new Date(endTime)
        const durationMs = end - start
        const durationMin = Math.floor(durationMs / 60000)
        const durationSec = Math.floor((durationMs % 60000) / 1000)
        const startTimeStr = start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
        const endTimeStr = end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
        timeInfo = ` (${startTimeStr} - ${endTimeStr}, ${durationMin} min)`
      }

      eventDescription = `Team ${winnerLabel} won Set ${setIndex}${timeInfo}`
    } else if (event.type === 'set5_coin_toss') {
      const leftTeam = event.payload?.leftTeam || '?'
      const firstServe = event.payload?.firstServe || '?'
      eventDescription = `Set 5 coin toss — Left: Team ${leftTeam}, First serve: Team ${firstServe}`
    } else if (event.type === 'sanction') {
      const sanctionType = event.payload?.type || 'unknown'
      const sanctionLabel = sanctionType === 'improper_request' ? 'Improper Request' :
                            sanctionType === 'delay_warning' ? 'Delay Warning' :
                            sanctionType === 'delay_penalty' ? 'Delay Penalty' :
                            sanctionType === 'warning' ? 'Warning' :
                            sanctionType === 'penalty' ? 'Penalty' :
                            sanctionType === 'expulsion' ? 'Expulsion' :
                            sanctionType === 'disqualification' ? 'Disqualification' :
                            sanctionType
      
      // Add player/official info if available
      let target = ''
      if (event.payload?.playerNumber) {
        target = ` ${event.payload.playerNumber}`
      } else if (event.payload?.role) {
        const roleAbbr = event.payload.role === 'Coach' ? 'C' : 
                        event.payload.role === 'Assistant Coach 1' ? 'AC1' :
                        event.payload.role === 'Assistant Coach 2' ? 'AC2' :
                        event.payload.role === 'Physiotherapist' ? 'P' :
                        event.payload.role === 'Medic' ? 'M' : event.payload.role
        target = ` ${roleAbbr}`
      } else {
        target = ' Team'
      }
      
      eventDescription = `Sanction — ${teamName}${target} (${sanctionLabel}) (${homeLabel} ${homeScore}:${awayScore} ${awayLabel})`
    } else if (event.type === 'remark') {
      const remarkText = event.payload?.text || ''
      // Show first line or first 50 characters
      const preview = remarkText.split('\n')[0].substring(0, 50)
      eventDescription = `Remark added — ${preview}${remarkText.length > 50 ? '...' : ''}`
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
    if (!data?.events || data.events.length === 0 || !data?.set) return

    // IMPORTANT: Only consider events from the CURRENT SET
    // Undo should NEVER affect other sets - use "Reopen set" in manual changes for that
    const currentSetIndex = data.set.index
    const currentSetEvents = data.events.filter(e => e.setIndex === currentSetIndex)

    if (currentSetEvents.length === 0) return

    // Find the last event by sequence number (highest seq)
    const sortedEvents = [...currentSetEvents].sort((a, b) => {
      const aSeq = a.seq || 0
      const bSeq = b.seq || 0
      if (aSeq !== 0 || bSeq !== 0) {
        return bSeq - aSeq // Descending
      }
      // Fallback to timestamp
      const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
      const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
      return bTime - aTime
    })

    // Find the most recent event (highest sequence)
    const lastEvent = sortedEvents[0]
    if (!lastEvent) return

    // If it's a rotation lineup, find the point before it and undo that instead
    if (lastEvent.type === 'lineup' && !lastEvent.payload?.isInitial && !lastEvent.payload?.fromSubstitution && !lastEvent.payload?.liberoSubstitution) {
      // This is a rotation lineup - find the point that triggered it
      const pointBefore = sortedEvents.find(e => e.type === 'point' && (e.seq || 0) < (lastEvent.seq || 0))
      if (pointBefore) {
        const description = getActionDescription(pointBefore)
        setUndoConfirm({ event: pointBefore, description })
        return
      }
    }

    const lastUndoableEvent = lastEvent

    if (!lastUndoableEvent) return

    const description = getActionDescription(lastUndoableEvent)
    // getActionDescription returns null for rotation lineups, but we've already filtered those out
    // So if it returns null here, try to find the next undoable event
    if (!description || description === 'Unknown action') {
      // Find the next undoable event after this one
      const currentIndex = sortedEvents.findIndex(e => e.id === lastUndoableEvent.id)
      const nextUndoableEvent = sortedEvents.slice(currentIndex + 1).find(e => {
          if (e.type === 'lineup') {
            const hasInitial = e.payload?.isInitial === true
            const hasSubstitution = e.payload?.fromSubstitution === true
            // Skip libero substitution lineups and rotation lineups
            if (!hasInitial && !hasSubstitution) {
              return false
            }
          }
        // Allow rally_start, set_start, and replay events to be undone
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
  }, [data?.events, data?.set, getActionDescription])

  const handleUndo = useCallback(async () => {
    if (!undoConfirm || !data?.set) {
      setUndoConfirm(null)
      return
    }

    const lastEvent = undoConfirm.event
    const lastEventSeq = lastEvent.seq || 0
    const baseSeq = Math.floor(lastEventSeq) // Get integer part (e.g., 1 from 1.1 or 1.2)
    // Get the next sequence number ONCE at the start, before any deletions
    // This ensures consistent sequential IDs even when multiple events are added during undo
    let nextSeqCounter = await getNextSeq()
    const getNextSeqInUndo = () => nextSeqCounter++

    // Find and delete ALL events with the same base ID (1, 1.1, 1.2, etc.)
    const allEvents = await db.events.where('matchId').equals(matchId).toArray()
    const eventsToDelete = allEvents.filter(e => {
      const eSeq = e.seq || 0
      return Math.floor(eSeq) === baseSeq
    })

    // Delete all related events
    for (const eventToDelete of eventsToDelete) {
      await db.events.delete(eventToDelete.id)
    }
    
    // Mark that we've already deleted the main event
    let eventAlreadyDeleted = true

    try {
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
        
        // Check if this is set 5 and we're undoing a point that triggered court switch at 8 points
        const is5thSet = data.set.index === 5
        const wasAt8Points = currentPoints === 8
        if (is5thSet && wasAt8Points && data.match?.set5CourtSwitched) {
          // Undo the court switch
          await db.matches.update(matchId, { set5CourtSwitched: false })
        }
        
      if (currentPoints > 0) {
        await db.sets.update(data.set.id, {
          [field]: currentPoints - 1
        })
      }

      // Note: Rotation lineup and libero_exit events are already deleted above
      // (they have the same base ID as the point, so they were deleted with all related events)
      // Point event is already deleted above (with all related events)

      // Also delete the rally_start event that preceded this point
      // The rally_start has a different sequence ID but should be undone with the point
      // Find the most recent rally_start before this point
      const pointSeq = lastEvent.seq || 0
      const rallyStartEvent = data.events
        .filter(e =>
          e.type === 'rally_start' &&
          e.setIndex === data.set.index &&
          (e.seq || 0) < pointSeq
        )
        .sort((a, b) => (b.seq || 0) - (a.seq || 0))[0] // Most recent rally_start before the point

      if (rallyStartEvent) {
        await db.events.delete(rallyStartEvent.id)
      }
    }
    
    // If it's an initial lineup, delete it (players go back to bench)
    if (lastEvent.type === 'lineup' && lastEvent.payload?.isInitial === true) {
      // Simply delete the initial lineup event
      // This will cause players to go back to the bench
      await db.events.delete(lastEvent.id)
      eventAlreadyDeleted = true
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
        const restoredSubSeq = getNextSeqInUndo()
        await db.events.add({
          matchId,
          setIndex: data.set.index,
          type: 'lineup',
          payload: { team, lineup: restoredLineup, fromSubstitution: true },
          ts: new Date().toISOString(),
          seq: restoredSubSeq
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
          const restoredLiberoEntrySeq = getNextSeqInUndo()
          await db.events.add({
            matchId,
            setIndex: data.set.index,
            type: 'lineup',
            payload: {
              team,
              lineup: restoredLineup,
              liberoSubstitution: null // Explicitly clear libero substitution
            },
            ts: new Date().toISOString(),
            seq: restoredLiberoEntrySeq
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
            const restoredLiberoEntrySeq2 = getNextSeqInUndo()
            await db.events.add({
              matchId,
              setIndex: data.set.index,
              type: 'lineup',
              payload: {
                team,
                lineup: restoredLineup,
                liberoSubstitution: null // Explicitly clear libero substitution
              },
              ts: new Date().toISOString(),
              seq: restoredLiberoEntrySeq2
            })
          }
        }
      }
    }
    
    // Track if we've already deleted the event (to avoid double deletion)
    let eventAlreadyDeleted = false
    
    // If it's a rally_start, delete it and all subsequent rally_start events (duplicates)
    if (lastEvent.type === 'rally_start') {
      const rallyStartTimestamp = new Date(lastEvent.ts)

      // Delete this rally_start
      await db.events.delete(lastEvent.id)
      eventAlreadyDeleted = true

      // Delete all other rally_start events that came after this one (duplicates)
      const allRallyStarts = data.events.filter(e =>
        e.type === 'rally_start' &&
        e.setIndex === data.set.index &&
        e.id !== lastEvent.id &&
        new Date(e.ts) >= rallyStartTimestamp
      )
      for (const duplicateRallyStart of allRallyStarts) {
        await db.events.delete(duplicateRallyStart.id)
      }

      // If this was the first rally_start (oldest), also undo set_start
      const allRallyStartsSorted = data.events
        .filter(e => e.type === 'rally_start' && e.setIndex === data.set.index && e.id !== lastEvent.id)
        .sort((a, b) => new Date(a.ts) - new Date(b.ts)) // Oldest first

      // If there are no other rally_start events, this was the first one
      if (allRallyStartsSorted.length === 0 ||
          (allRallyStartsSorted.length > 0 && new Date(allRallyStartsSorted[0].ts) > rallyStartTimestamp)) {
        // Find the set_start event for this set
        const setStartEvent = data.events.find(e =>
          e.type === 'set_start' &&
          e.setIndex === data.set.index
        )
        if (setStartEvent) {
          await db.events.delete(setStartEvent.id)
        }
      }
    }

    // If it's a set_start, delete it
    if (lastEvent.type === 'set_start') {
      await db.events.delete(lastEvent.id)
      eventAlreadyDeleted = true
    }
    
    // If it's a replay, delete it
    if (lastEvent.type === 'replay') {
      await db.events.delete(lastEvent.id)
      eventAlreadyDeleted = true
    }
    
    // If it's a set_end, undo the set completion
    if (lastEvent.type === 'set_end') {
      // Mark the set as not finished
      await db.sets.update(data.set.id, { finished: false })
      
      // Delete the next set if it was created
      const allSets = await db.sets.where('matchId').equals(matchId).toArray()
      const nextSet = allSets.find(s => s.index === data.set.index + 1)
      if (nextSet) {
        // Delete all events for the next set
        await db.events.where('matchId').equals(matchId).and(e => e.setIndex === nextSet.index).delete()
        // Delete the next set
        await db.sets.delete(nextSet.id)
      }
      
      // Update match status back to 'live' if it was set to 'final'
      if (data.match?.status === 'final') {
        await db.matches.update(matchId, { status: 'live' })
      }
      
      await db.events.delete(lastEvent.id)
      eventAlreadyDeleted = true
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
          const restoredLiberoExitSeq = getNextSeqInUndo()
          await db.events.add({
            matchId,
            setIndex: data.set.index,
            type: 'lineup',
            payload: {
              team,
              lineup: restoredLineup,
              liberoSubstitution: previousLiberoSub || null
            },
            ts: new Date().toISOString(),
            seq: restoredLiberoExitSeq
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
            const restoredExchangeSeq = getNextSeqInUndo()
            await db.events.add({
              matchId,
              setIndex: data.set.index,
              type: 'lineup',
              payload: {
                team,
                lineup: restoredLineup,
                liberoSubstitution: restoredLiberoSub
              },
              ts: new Date().toISOString(),
              seq: restoredExchangeSeq
            })
          } else {
            // No previous libero sub, just restore the lineup
            const restoredExchangeSeq2 = getNextSeqInUndo()
            await db.events.add({
              matchId,
              setIndex: data.set.index,
              type: 'lineup',
              payload: {
                team,
                lineup: restoredLineup,
                liberoSubstitution: null
              },
              ts: new Date().toISOString(),
              seq: restoredExchangeSeq2
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
      // Sanction event will be deleted at the end of the function
    }
    
    // All events with the same base ID have already been deleted at the start
    // No need to delete again here
    
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
    } catch (error) {
      // Error during undo - silently handle
    } finally {
      // Always close the modal
      setUndoConfirm(null)
    }
  }, [undoConfirm, data?.events, data?.set, data?.match, matchId, leftIsHome, getActionDescription, getNextSeq])

  const cancelUndo = useCallback(() => {
    setUndoConfirm(null)
  }, [])

  // Handle replay rally - undo last point (go back to state before the point, no rally restart)
  const handleReplayRally = useCallback(async () => {
    if (!replayRallyConfirm || !data?.set) {
      setReplayRallyConfirm(null)
      return
    }

    const lastEvent = replayRallyConfirm.event
    const lastEventSeq = lastEvent.seq || 0
    const baseSeq = Math.floor(lastEventSeq)

    // Find and delete ALL events with the same base ID (point and any related rotation events)
    const allEvents = await db.events.where('matchId').equals(matchId).toArray()
    const eventsToDelete = allEvents.filter(e => {
      const eSeq = e.seq || 0
      return Math.floor(eSeq) === baseSeq
    })

    try {
      // If it's a point, undo the score change
      if (lastEvent.type === 'point' && lastEvent.payload?.team) {
        const team = lastEvent.payload.team
        const field = team === 'home' ? 'homePoints' : 'awayPoints'
        const currentPoints = data.set[field]

        // Decrement the score
        if (currentPoints > 0) {
          await db.sets.update(data.set.id, {
            [field]: currentPoints - 1
          })
        }

        // Check if there was a rotation after this point (sideout)
        // Find the lineup event that came right after this point (rotation)
        const pointEvents = data.events.filter(e => e.type === 'point' && e.setIndex === data.set.index)
        const sortedPoints = pointEvents.sort((a, b) => (b.seq || 0) - (a.seq || 0))

        // Get the team that had the point before this one (to determine who had serve)
        let previousServeTeam = data?.match?.firstServe || 'home'
        if (sortedPoints.length > 1) {
          // The second point is the one before the current one
          previousServeTeam = sortedPoints[1].payload?.team || previousServeTeam
        }

        // If the scoring team didn't have serve (sideout), a rotation was logged after the point
        // We need to undo that rotation too
        if (lastEvent.payload.team !== previousServeTeam) {
          // Find the rotation lineup that was created after this point
          const lineupEvents = data.events.filter(e =>
            e.type === 'lineup' &&
            e.setIndex === data.set.index &&
            !e.payload?.isInitial &&
            !e.payload?.fromSubstitution &&
            (e.seq || 0) > lastEventSeq
          ).sort((a, b) => (a.seq || 0) - (b.seq || 0)) // Ascending by seq

          // The first lineup event after the point is the rotation
          if (lineupEvents.length > 0 && lineupEvents[0].payload?.team === lastEvent.payload.team) {
            const rotationEvent = lineupEvents[0]
            await db.events.delete(rotationEvent.id)
          }
        }
      }

      // Delete all events with this base seq
      for (const eventToDelete of eventsToDelete) {
        await db.events.delete(eventToDelete.id)
      }

      // Do NOT start a new rally - just go back to the state before the point
      // The rally will be in 'idle' state, waiting for "Start rally" to be clicked

    } catch (error) {
      // Error during replay - silently handle
    } finally {
      setReplayRallyConfirm(null)
    }
  }, [replayRallyConfirm, data?.events, data?.set, data?.match, matchId])

  const cancelReplayRally = useCallback(() => {
    setReplayRallyConfirm(null)
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
    
    // Send timeout action to referee to show modal
    sendActionToReferee('timeout', {
      team: timeoutModal.team,
      countdown: 30
    })
  }, [timeoutModal, logEvent, sendActionToReferee])

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

  // Get timeout details with scores
  const getTimeoutDetails = useCallback(
    side => {
      if (!data?.events || !data?.set) return []
      const teamKey = mapSideToTeamKey(side)
      const setIndex = data.set.index
      
      // Get all timeout events for this team in current set
      const timeoutEvents = data.events.filter(e => 
        e.type === 'timeout' && 
        e.setIndex === setIndex &&
        e.payload?.team === teamKey
      )
      
      // Calculate scores at the time of each timeout
      const details = timeoutEvents.map((event, index) => {
        // Get all point events before this timeout
        // Sort events by seq if available, otherwise by timestamp
        const eventTime = event.seq || (typeof event.ts === 'number' ? event.ts : new Date(event.ts).getTime())
        const pointsBefore = data.events.filter(e => {
          if (e.type !== 'point' || e.setIndex !== setIndex) return false
          const eTime = e.seq || (typeof e.ts === 'number' ? e.ts : new Date(e.ts).getTime())
          return eTime < eventTime
        })
        
        let homeScore = 0
        let awayScore = 0
        pointsBefore.forEach(e => {
          if (e.payload?.team === 'home') homeScore++
          else if (e.payload?.team === 'away') awayScore++
        })
        
        return {
          event,
          score: `${homeScore}:${awayScore}`,
          index: index + 1
        }
      })
      
      return details
    },
    [data?.events, data?.set, mapSideToTeamKey]
  )

  // Get substitution details with scores
  const getSubstitutionDetails = useCallback(
    side => {
      if (!data?.events || !data?.set) return []
      const teamKey = mapSideToTeamKey(side)
      const setIndex = data.set.index
      
      // Get all substitution events for this team in current set
      const substitutionEvents = data.events.filter(e => 
        e.type === 'substitution' && 
        e.setIndex === setIndex &&
        e.payload?.team === teamKey &&
        !e.payload?.isExceptional
      )
      
      // Calculate scores at the time of each substitution
      const details = substitutionEvents.map((event, index) => {
        // Get all point events before this substitution
        // Sort events by seq if available, otherwise by timestamp
        const eventTime = event.seq || (typeof event.ts === 'number' ? event.ts : new Date(event.ts).getTime())
        const pointsBefore = data.events.filter(e => {
          if (e.type !== 'point' || e.setIndex !== setIndex) return false
          const eTime = e.seq || (typeof e.ts === 'number' ? e.ts : new Date(e.ts).getTime())
          return eTime < eventTime
        })
        
        let homeScore = 0
        let awayScore = 0
        pointsBefore.forEach(e => {
          if (e.payload?.team === 'home') homeScore++
          else if (e.payload?.team === 'away') awayScore++
        })
        
        return {
          event,
          score: `${homeScore}:${awayScore}`,
          playerOut: event.payload?.playerOut,
          playerIn: event.payload?.playerIn,
          position: event.payload?.position,
          index: index + 1
        }
      })
      
      return details
    },
    [data?.events, data?.set, mapSideToTeamKey]
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

  const leftTeamSubstitutionHistory = useMemo(() => 
    getSubstitutionHistory(leftIsHome ? 'home' : 'away'),
    [getSubstitutionHistory, leftIsHome]
  )

  const rightTeamSubstitutionHistory = useMemo(() => 
    getSubstitutionHistory(leftIsHome ? 'away' : 'home'),
    [getSubstitutionHistory, leftIsHome]
  )

  const buildActiveReplacementMap = (substitutions = []) => {
    const activeMap = new Map()

    substitutions.forEach(sub => {
      const playerOut = sub.payload?.playerOut
      const playerIn = sub.payload?.playerIn
      if (!playerOut || !playerIn) return

      const playerOutStr = String(playerOut)
      const playerInStr = String(playerIn)
      const previouslyReplaced = activeMap.get(playerOutStr)

      activeMap.delete(playerOutStr)

      if (previouslyReplaced && previouslyReplaced === playerInStr) {
        // Original player returning, do not mark as replacement
        return
      }

      activeMap.set(playerInStr, playerOutStr)
    })

    return activeMap
  }

  const leftTeamActiveReplacements = useMemo(
    () => buildActiveReplacementMap(leftTeamSubstitutionHistory),
    [leftTeamSubstitutionHistory]
  )

  const rightTeamActiveReplacements = useMemo(
    () => buildActiveReplacementMap(rightTeamSubstitutionHistory),
    [rightTeamSubstitutionHistory]
  )

  const resolveReplacementNumber = (player, activeReplacementMap) => {
    if (!player || !player.number || player.number === '' || player.isPlaceholder) {
      return null
    }

    if (player.isLibero && player.substitutedPlayerNumber) {
      return String(player.substitutedPlayerNumber)
    }

    if (!activeReplacementMap) return null

    return activeReplacementMap.get(String(player.number)) || null
  }

  const getReplacementBadgeStyle = (player) => {
    const baseStyle = {
      position: 'absolute',
      top: '-8px',
      right: '-8px',
      width: '18px',
      height: '18px',
      borderRadius: '4px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '10px',
      fontWeight: 700,
      zIndex: 6
    }

    const isLiberoReplacement = player?.isLibero && player?.substitutedPlayerNumber

    if (isLiberoReplacement) {
      return {
        ...baseStyle,
        background: '#ffffff',
        border: '2px solid rgba(255, 255, 255, 0.8)',
        color: '#0f172a',
        boxShadow: '0 2px 6px rgba(15, 23, 42, 0.35)'
      }
    }

    return {
      ...baseStyle,
      background: '#fde047',
      border: '2px solid rgba(0, 0, 0, 0.25)',
      color: '#0f172a',
      boxShadow: '0 2px 4px rgba(15, 23, 42, 0.25)'
    }
  }

  // Helper functions to check substitution types
  const wasSubstitutedDueToExpulsion = useCallback((teamKey, playerNumber) => {
    if (!data?.events) return false
    return data.events.some(e => 
      e.type === 'substitution' && 
      e.payload?.team === teamKey &&
      String(e.payload?.playerOut) === String(playerNumber) &&
      e.payload?.isExpelled === true
    )
  }, [data?.events])

  const wasSubstitutedDueToDisqualification = useCallback((teamKey, playerNumber) => {
    if (!data?.events) return false
    return data.events.some(e => 
      e.type === 'substitution' && 
      e.payload?.team === teamKey &&
      String(e.payload?.playerOut) === String(playerNumber) &&
      e.payload?.isDisqualified === true
    )
  }, [data?.events])

  const wasExceptionallySubstituted = useCallback((teamKey, playerNumber) => {
    if (!data?.events) return false
    return data.events.some(e => 
      e.type === 'substitution' && 
      e.payload?.team === teamKey &&
      String(e.payload?.playerOut) === String(playerNumber) &&
      e.payload?.isExceptional === true
    )
  }, [data?.events])

  const canPlayerReEnter = useCallback((teamKey, playerNumber, currentSetIndex) => {
    if (!data?.events || !currentSetIndex) return true

    // Check if player was substituted due to disqualification - cannot re-enter for rest of game
    if (wasSubstitutedDueToDisqualification(teamKey, playerNumber)) {
      return false
    }

    // Check if player was exceptionally substituted - cannot re-enter for rest of game
    if (wasExceptionallySubstituted(teamKey, playerNumber)) {
      return false
    }

    // Check if player was substituted due to expulsion - cannot re-enter for rest of set
    if (wasSubstitutedDueToExpulsion(teamKey, playerNumber)) {
      // Check if this is the same set where they were expelled
      const expulsionSub = data.events.find(e => 
        e.type === 'substitution' && 
        e.payload?.team === teamKey &&
        String(e.payload?.playerOut) === String(playerNumber) &&
        e.payload?.isExpelled === true
      )
      if (expulsionSub && expulsionSub.setIndex === currentSetIndex) {
        return false // Cannot re-enter in same set
      }
    }

    return true
  }, [data?.events, wasSubstitutedDueToExpulsion, wasSubstitutedDueToDisqualification, wasExceptionallySubstituted])

  // Check if a player on court can be substituted
  const canPlayerBeSubstituted = useCallback((teamKey, playerNumber) => {
    if (!data?.events || !data?.set) return true
    
    // Get all substitutions for this team in current set
    const substitutions = getSubstitutionHistory(teamKey)
    
    // Get all substitutions where this player was involved (either in or out)
    const substitutionsWherePlayerIn = substitutions.filter(s => 
      String(s.payload?.playerIn) === String(playerNumber)
    )
    const substitutionsWherePlayerOut = substitutions.filter(s => 
      String(s.payload?.playerOut) === String(playerNumber)
    )
    
    // If player was never involved in any substitution, they can be substituted
    if (substitutionsWherePlayerIn.length === 0 && substitutionsWherePlayerOut.length === 0) {
      return true
    }
    
    // Check if player was substituted out and came back (completed cycle)
    // This means: Player A out -> Player B in -> Player B out -> Player A in
    if (substitutionsWherePlayerOut.length > 0) {
      // Find the most recent substitution where this player went out
      const lastSubOut = substitutionsWherePlayerOut[substitutionsWherePlayerOut.length - 1]
      const playerWhoCameIn = lastSubOut.payload?.playerIn
      
      // Check if the player who came in has been substituted out with this player coming back
      const hasComeBack = substitutions.some(s => 
        String(s.payload?.playerOut) === String(playerWhoCameIn) &&
        String(s.payload?.playerIn) === String(playerNumber) &&
        new Date(s.ts) > new Date(lastSubOut.ts)
      )
      
      if (hasComeBack) {
        // Player was out and came back - cycle complete, cannot be substituted
        return false
      }
    }
    
    // Check if player was substituted in and the original player came back (completed cycle)
    // This means: Player A out -> Player B in -> Player B out -> Player A in
    // But from Player B's perspective: Player B in (for A) -> Player B out (A comes back)
    if (substitutionsWherePlayerIn.length > 0) {
      // Find the most recent substitution where this player came in
      const lastSubIn = substitutionsWherePlayerIn[substitutionsWherePlayerIn.length - 1]
      const originalPlayerOut = lastSubIn.payload?.playerOut
    
    // Check if there was a point change since this substitution
      const lastSubstitutionIndex = lastSubIn.eventIndex
    const eventsAfterSub = data.events
      .filter((e, idx) => idx > lastSubstitutionIndex && (e.setIndex || 1) === data.set.index)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    
    const pointAfterSub = eventsAfterSub.find(e => e.type === 'point')
    
      if (pointAfterSub) {
        // There was a point change, check if the original player came back
        // This means: this player (who came in) was substituted out, and original came back
    const hasComeBack = substitutions.some(s => 
      String(s.payload?.playerOut) === String(playerNumber) &&
      String(s.payload?.playerIn) === String(originalPlayerOut) &&
          new Date(s.ts) > new Date(lastSubIn.ts)
        )
        
        if (hasComeBack) {
          // Original player came back - cycle complete, cannot be substituted
          return false
        }
        
        // Original player hasn't come back yet, but there was a point change
        // This player can be substituted out (to let original come back)
        return true
      }
      
      // No point change yet - cannot substitute yet (must wait for point)
      return false
    }
    
    // If we get here, the player can be substituted
    return true
  }, [data?.events, data?.set, getSubstitutionHistory])

  // Check if a substitution is legal (not exceptional)
  const isSubstitutionLegal = useCallback((teamKey, playerOutNumber) => {
    if (!data?.events || !data?.set) return true
    
    // Check substitution limit (6 per set)
    const substitutions = getSubstitutionHistory(teamKey)
    if (substitutions.length >= 6) return false
    
    // Check if player can be substituted
    return canPlayerBeSubstituted(teamKey, playerOutNumber)
  }, [data?.events, data?.set, getSubstitutionHistory, canPlayerBeSubstituted])

  // Get available substitutes for a player being substituted out
  const getAvailableSubstitutes = useCallback((teamKey, playerOutNumber, allowExceptional = false) => {
    if (!data) return []
    
    const benchPlayers = teamKey === 'home' 
      ? (leftIsHome ? leftTeamBench.benchPlayers : rightTeamBench.benchPlayers)
      : (leftIsHome ? rightTeamBench.benchPlayers : leftTeamBench.benchPlayers)
    
    // Filter out liberos
    let available = benchPlayers.filter(p => !p.libero || p.libero === '')
    
    // Filter out players currently replaced by a libero (cannot be substituted while libero is in for them)
    const liberoEntries = data.events?.filter(e => 
      e.type === 'libero_entry' && 
      e.payload?.team === teamKey && 
      e.setIndex === data.set.index
    ) || []
    
    const liberoExits = data.events?.filter(e => 
      e.type === 'libero_exit' && 
      e.payload?.team === teamKey && 
      e.setIndex === data.set.index
    ) || []
    
    // Find players currently replaced by libero (libero entered for them, libero hasn't exited yet)
    const playersReplacedByLibero = new Set()
    liberoEntries.forEach(entry => {
      const playerOut = entry.payload?.playerOut
      // Check if libero has exited since this entry
      const liberoHasExited = liberoExits.some(exit => 
        exit.payload?.playerIn === playerOut &&
        (exit.seq || 0) > (entry.seq || 0)
      )
      if (!liberoHasExited && playerOut) {
        playersReplacedByLibero.add(Number(playerOut))
      }
    })
    
    // Filter out players currently replaced by libero
    available = available.filter(p => !playersReplacedByLibero.has(Number(p.number)))
    
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
        // If already came back, check if exceptional substitution is allowed
        if (allowExceptional) {
          // For exceptional substitution, return all bench players (except liberos and those who cannot re-enter)
          return available.filter(p => canPlayerReEnter(teamKey, p.number, data.set.index))
        }
        return []
      } else {
        // No point change yet, check if exceptional substitution is allowed
        if (allowExceptional) {
          // For exceptional substitution, return all bench players (except liberos and those who cannot re-enter)
          return available.filter(p => canPlayerReEnter(teamKey, p.number, data.set.index))
        }
        return []
      }
    }
    
    // Player was not substituted in, so any bench player can substitute
    // But filter out players who were substituted out but can't come back yet (no point change)
    // And filter out players who already came back (got in and out again)
    // And filter out players who cannot re-enter (expelled/disqualified/exceptionally substituted)
    available = available.filter(player => {
      // Check if player can re-enter using helper function
      if (!canPlayerReEnter(teamKey, player.number, data.set.index)) {
        return false
      }
      
      // Check if player was substituted out
      const playerSubstitutionsOut = substitutions.filter(s => 
        String(s.payload?.playerOut) === String(player.number)
      )
      
      // Check if player was substituted in
      const playerSubstitutionsIn = substitutions.filter(s => 
        String(s.payload?.playerIn) === String(player.number)
      )
      
      // If player was never substituted, they're available
      if (playerSubstitutionsOut.length === 0 && playerSubstitutionsIn.length === 0) {
        return true
      }
      
      // If player was substituted in, they cannot be substituted again (except exceptional)
      // This means they were on court, got substituted out, and are now on bench
      // They've completed a cycle and cannot re-enter
      if (playerSubstitutionsIn.length > 0) {
        return allowExceptional
      }
      
      // Player was substituted out (but never substituted in)
      // They can only come back for the SPECIFIC player they were substituted out for
      const lastSubstitutionOut = playerSubstitutionsOut[playerSubstitutionsOut.length - 1]
      const playerTheyWereSubstitutedFor = lastSubstitutionOut.payload?.playerIn
      
      // Check if they came back for that specific player
      const hasComeBackForSpecificPlayer = substitutions.some(s => 
        String(s.payload?.playerOut) === String(playerTheyWereSubstitutedFor) &&
        String(s.payload?.playerIn) === String(player.number) &&
        new Date(s.ts) > new Date(lastSubstitutionOut.ts)
      )
      
      // If they came back, they've completed a cycle and cannot be substituted again (except exceptional)
      if (hasComeBackForSpecificPlayer) {
          return allowExceptional
      }
      
      // Player was substituted out but hasn't come back yet
      // They can only come back for the specific player they were substituted out for
      // Check if the player being substituted out now is that specific player
      if (String(playerTheyWereSubstitutedFor) !== String(playerOutNumber)) {
        // Not the right player - this player cannot substitute for anyone else
        return false
      }
      
      // This is the right player, check if there was a point change
      const lastSubstitutionIndex = lastSubstitutionOut.eventIndex
      const eventsAfterSub = data.events
        .filter((e, idx) => idx > lastSubstitutionIndex && (e.setIndex || 1) === data.set.index)
        .sort((a, b) => new Date(a.ts) - new Date(b.ts))
      
      const pointAfterSub = eventsAfterSub.find(e => e.type === 'point')
      
      if (!pointAfterSub) {
        // No point change yet - cannot come back (except exceptional)
      return allowExceptional
      }
      
      // Point change occurred, player can come back for this specific player
      return true
    })
    
    return available.sort((a, b) => (a.number || 0) - (b.number || 0))
  }, [data, leftIsHome, leftTeamBench, rightTeamBench, getSubstitutionHistory, data?.events, canPlayerReEnter])

  // Get available players for exceptional substitution
  // Excludes: liberos, expelled/disqualified players, and the player being replaced
  const getAvailableExceptionalSubstitutes = useCallback((teamKey, playerOutNumber) => {
    if (!data) return []
    
    const benchPlayers = teamKey === 'home' 
      ? (leftIsHome ? leftTeamBench.benchPlayers : rightTeamBench.benchPlayers)
      : (leftIsHome ? rightTeamBench.benchPlayers : leftTeamBench.benchPlayers)
    
    // Get all liberos (both L1 and L2)
    const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
    const liberos = teamPlayers?.filter(p => p.libero && p.libero !== '') || []
    const liberoNumbers = new Set(liberos.map(p => Number(p.number)))
    
    // Filter available players
    const available = benchPlayers.filter(p => {
      const playerNum = Number(p.number)
      
      // Exclude liberos
      if (liberoNumbers.has(playerNum)) return false
      
      // Exclude the player being replaced
      if (String(playerNum) === String(playerOutNumber)) return false
      
      // Exclude players who cannot re-enter (expelled/disqualified/exceptionally substituted)
      if (!canPlayerReEnter(teamKey, playerNum, data.set.index)) return false
      
      return true
    })
    
    return available.sort((a, b) => (a.number || 0) - (b.number || 0))
  }, [data, leftIsHome, leftTeamBench, rightTeamBench, canPlayerReEnter])

  // Check if a bench player can come back (was substituted out, has point change, hasn't come back yet)
  const canPlayerComeBack = useCallback((teamKey, playerNumber) => {
    if (!data?.events || !data?.set) return false
    
    // Check if player is disqualified - disqualified players cannot re-enter
    const playerSanctions = data.events.filter(e => 
      e.type === 'sanction' && 
      e.payload?.team === teamKey &&
      e.payload?.playerNumber === playerNumber &&
      e.payload?.type === 'disqualification'
    )
    if (playerSanctions.length > 0) return false // Disqualified, cannot re-enter
    
    const substitutions = getSubstitutionHistory(teamKey)
    
    // Check if this player was substituted out
    const playerSubstitutions = substitutions.filter(s => 
      String(s.payload?.playerOut) === String(playerNumber)
    )
    
    if (playerSubstitutions.length === 0) return false // Never substituted out
    
    const lastSubstitution = playerSubstitutions[playerSubstitutions.length - 1]
    const lastSubstitutionIndex = lastSubstitution.eventIndex
    
    // Check if player was expelled - expelled players can only re-enter in next set
    // If expelled in current set, cannot re-enter in current set
    const expulsionSanctions = data.events.filter(e => 
      e.type === 'sanction' && 
      e.payload?.team === teamKey &&
      e.payload?.playerNumber === playerNumber &&
      e.payload?.type === 'expulsion' &&
      (e.setIndex || 1) === data.set.index
    )
    if (expulsionSanctions.length > 0) {
      return false // Expelled in this set, can only re-enter next set
    }
    
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

  // Handle player click for substitution/libero/sanction/injury (only when rally is not in play and lineup is set)
  const handlePlayerClick = useCallback((teamKey, position, playerNumber, event) => {
    // Only allow when rally is not in play and lineup is set
    if (rallyStatus !== 'idle') return
    if (isRallyReplayed) return // Don't allow actions when rally is replayed
    if (!leftTeamLineupSet && teamKey === (leftIsHome ? 'home' : 'away')) return
    if (!rightTeamLineupSet && teamKey === (leftIsHome ? 'away' : 'home')) return
    if (!playerNumber || playerNumber === '') return // Can't substitute placeholder
    
    // Check if this player is a libero - liberos cannot be substituted
    const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
    const clickedPlayer = teamPlayers?.find(p => String(p.number) === String(playerNumber))
    const isLibero = clickedPlayer?.libero && clickedPlayer.libero !== ''
    
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
    const canEnterLibero = !isLibero && liberos.length > 0 && (liberoOnCourt === null || liberoOnCourt === undefined)
    
    // Check if there has been a point since last libero exchange
    const hasPointSinceLibero = hasPointSinceLastLiberoExchange(teamKey)
    
    // Check substitution limit (6 per set)
    const teamSubstitutions = substitutionsUsed?.[teamKey] || 0
    const canSubstitute = !isLibero && !isRallyReplayed && teamSubstitutions < 6 && canPlayerBeSubstituted(teamKey, playerNumber)
    
    // Get the clicked element position (the circle)
    const element = event.currentTarget
    const rect = element.getBoundingClientRect()
    
    // Calculate center of the circle
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    
    // Calculate radius (half the width/height)
    const radius = rect.width / 2
    
    // Offset to move menu from the circle
    const offset = radius + 30 // Add 30px extra spacing
    
    // Close menu if it's already open for this player
    if (playerActionMenu?.playerNumber === playerNumber && playerActionMenu?.position === position) {
      setPlayerActionMenu(null)
      return
    }
    
    // Show action menu with buttons
    setPlayerActionMenu({
      team: teamKey,
      position,
      playerNumber,
      element,
      x: centerX + offset,
      y: centerY,
      canSubstitute,
      canEnterLibero: isBackRow && !isServing && canEnterLibero && hasPointSinceLibero
    })
  }, [rallyStatus, isRallyReplayed, leftTeamLineupSet, rightTeamLineupSet, leftIsHome, playerActionMenu, substitutionsUsed, canPlayerBeSubstituted, getCurrentServe, getLiberoOnCourt, hasPointSinceLastLiberoExchange, data?.homePlayers, data?.awayPlayers])

  // Show substitution confirmation
  const showSubstitutionConfirm = useCallback((substituteNumber) => {
    if (!substitutionDropdown || !substituteNumber) return
    
    const teamKey = substitutionDropdown.team
    const playerOutNumber = substitutionDropdown.playerNumber
    
    // Check if substitution is legal or exceptional
    const isExceptional = substitutionDropdown.isExceptional === true
    const isLegal = !isExceptional && isSubstitutionLegal(teamKey, playerOutNumber)
    
    // Check if player is expelled or disqualified
    const playerSanctions = data?.events?.filter(e => 
      e.type === 'sanction' && 
      e.payload?.team === teamKey &&
      e.payload?.playerNumber === playerOutNumber &&
      (e.payload?.type === 'expulsion' || e.payload?.type === 'disqualification')
    ) || []
    const isExpelled = playerSanctions.some(s => s.payload?.type === 'expulsion')
    const isDisqualified = playerSanctions.some(s => s.payload?.type === 'disqualification')
    
    setSubstitutionConfirm({
      team: substitutionDropdown.team,
      position: substitutionDropdown.position,
      playerOut: substitutionDropdown.playerNumber,
      playerIn: substituteNumber,
      isInjury: substitutionDropdown.isInjury || false,
      isExceptional: isExceptional,
      isExpelled: isExpelled,
      isDisqualified: isDisqualified
    })
    setSubstitutionDropdown(null)
    setLiberoDropdown(null) // Close libero dropdown when selecting substitution
  }, [substitutionDropdown, isSubstitutionLegal, data?.events])

  // Check if a libero is unable to play (injured, expelled, disqualified, or declared unable)
  const isLiberoUnable = useCallback((teamKey, liberoNumber) => {
    if (!data?.events) return false
    
    // Check for expulsion or disqualification
    const sanctions = data.events.filter(e => 
      e.type === 'sanction' && 
      e.payload?.team === teamKey &&
      e.payload?.playerNumber === liberoNumber &&
      (e.payload?.type === 'expulsion' || e.payload?.type === 'disqualification')
    )
    if (sanctions.length > 0) return true
    
    // Check for libero_unable event (declared by coach)
    const unableEvents = data.events.filter(e => 
      e.type === 'libero_unable' && 
      e.payload?.team === teamKey &&
      e.payload?.liberoNumber === liberoNumber
    )
    if (unableEvents.length > 0) return true
    
    // Check if libero was injured (substituted due to injury)
    const injurySubs = data.events.filter(e => 
      e.type === 'substitution' && 
      e.payload?.team === teamKey &&
      e.payload?.playerOut === liberoNumber &&
      e.payload?.isInjury === true
    )
    if (injurySubs.length > 0) return true
    
    return false
  }, [data?.events])

  // Get available players for libero re-designation (not on court, not already libero, not re-designated)
  const getAvailablePlayersForRedesignation = useCallback((teamKey, unableLiberoNumber) => {
    if (!data) return []
    
    const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
    const { playersOnCourt } = getTeamLineupState(teamKey)
    const playersOnCourtSet = new Set(playersOnCourt.map(num => Number(num)))
    
    // Get all re-designation events to find already re-designated players
    const redesignationEvents = data?.events?.filter(e => 
      e.type === 'libero_redesignation' && 
      e.payload?.team === teamKey
    ) || []
    const redesignatedPlayerNumbers = new Set(
      redesignationEvents.map(e => e.payload?.newLiberoNumber).filter(n => n !== undefined && n !== null)
    )
    
    // Filter: not on court, not already a libero, not already re-designated, not the unable libero
    return teamPlayers.filter(p => {
      const playerNumber = Number(p.number)
      if (Number.isNaN(playerNumber)) return false
      if (playersOnCourtSet.has(playerNumber)) return false // On court
      if (p.libero && p.libero !== '') return false // Already a libero
      if (redesignatedPlayerNumbers.has(playerNumber)) return false // Already re-designated
      if (playerNumber === unableLiberoNumber) return false // The unable libero
      return true
    })
  }, [data, getTeamLineupState])

  // Check if libero re-designation is needed and trigger modal
  const checkLiberoRedesignation = useCallback((teamKey, liberoNumber, liberoType) => {
    if (!data?.set) return
    
    // Check if this libero is unable
    if (!isLiberoUnable(teamKey, liberoNumber)) return
    
    // Check if already re-designated
    const alreadyRedesignated = data?.events?.some(e => 
      e.type === 'libero_redesignation' && 
      e.payload?.team === teamKey &&
      e.payload?.unableLiberoNumber === liberoNumber
    )
    if (alreadyRedesignated) return
    
    // Check team libero rules
    const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
    const liberos = teamPlayers.filter(p => p.libero && p.libero !== '')
    const unableLiberos = liberos.filter(p => isLiberoUnable(teamKey, p.number))
    
    // If team has 2 liberos, can only re-designate if both are unable
    if (liberos.length === 2) {
      if (unableLiberos.length < 2) {
        // Still have one able libero, no re-designation needed
        // But if this is the second libero becoming unable, trigger re-designation
        if (unableLiberos.length === 1 && unableLiberos[0].number === liberoNumber) {
          // This is the second libero becoming unable, trigger re-designation
          const availablePlayers = getAvailablePlayersForRedesignation(teamKey, liberoNumber)
          if (availablePlayers.length === 0) {
            alert('No available players for libero re-designation. All players are either on court or already liberos.')
            return
          }
          setLiberoRedesignationModal({ team: teamKey, unableLiberoNumber: liberoNumber, unableLiberoType: liberoType })
          return
        }
        return
      }
    }
    
    // Get available players
    const availablePlayers = getAvailablePlayersForRedesignation(teamKey, liberoNumber)
    if (availablePlayers.length === 0) {
      alert('No available players for libero re-designation. All players are either on court or already liberos.')
      return
    }
    
    // Show re-designation modal
    setLiberoRedesignationModal({
      team: teamKey,
      unableLiberoNumber: liberoNumber,
      unableLiberoType: liberoType
    })
  }, [data?.set, data?.events, data?.homePlayers, data?.awayPlayers, isLiberoUnable, getAvailablePlayersForRedesignation])

  // Handle forfait - award all remaining points and sets to opponent
  const handleForfait = useCallback(async (teamKey, reason) => {
    if (!data?.set || !data?.match) return
    
    const opponentKey = teamKey === 'home' ? 'away' : 'home'
    const allSets = await db.sets.where({ matchId }).sortBy('index')
    const currentSetIndex = data.set.index
    const is5thSet = currentSetIndex === 5
    const pointsToWin = is5thSet ? 15 : 25
    
    // Award current set to opponent
    const currentSet = allSets.find(s => s.index === currentSetIndex)
    if (currentSet && !currentSet.finished) {
      const opponentPoints = pointsToWin
      const teamPoints = currentSet[teamKey === 'home' ? 'homePoints' : 'awayPoints']
      const currentOpponentPoints = currentSet[opponentKey === 'home' ? 'homePoints' : 'awayPoints']
      
      // Award points until opponent wins
      const pointsNeeded = opponentPoints - currentOpponentPoints
      if (pointsNeeded > 0) {
        for (let i = 0; i < pointsNeeded; i++) {
          await logEvent('point', {
            team: opponentKey
          })
        }
      }
      
      // End the set
      await db.sets.update(currentSet.id, {
        finished: true,
        [opponentKey === 'home' ? 'homePoints' : 'awayPoints']: opponentPoints,
        [teamKey === 'home' ? 'homePoints' : 'awayPoints']: teamPoints
      })
      
      // Log set end
      await logEvent('set_end', {
        team: opponentKey,
        setIndex: currentSetIndex,
        homePoints: opponentKey === 'home' ? opponentPoints : teamPoints,
        awayPoints: opponentKey === 'away' ? opponentPoints : teamPoints,
        reason: 'forfait'
      })
    }
    
    // Award all remaining sets to opponent
    const remainingSets = allSets.filter(s => s.index > currentSetIndex && !s.finished)
    for (const set of remainingSets) {
      const setPointsToWin = set.index === 5 ? 15 : 25
      await db.sets.update(set.id, {
        finished: true,
        [opponentKey === 'home' ? 'homePoints' : 'awayPoints']: setPointsToWin,
        [teamKey === 'home' ? 'homePoints' : 'awayPoints']: 0
      })
      
      await logEvent('set_end', {
        team: opponentKey,
        setIndex: set.index,
        homePoints: opponentKey === 'home' ? setPointsToWin : 0,
        awayPoints: opponentKey === 'away' ? setPointsToWin : 0,
        reason: 'forfait'
      })
    }
    
    // Log forfait event
    await logEvent('forfait', {
      team: teamKey,
      reason: reason,
      setIndex: currentSetIndex
    })
  }, [data?.set, data?.match, matchId, logEvent])

  // Handle exceptional substitution choice
  const handleExceptionalSubstitutionChoice = useCallback(async (choice) => {
    if (!exceptionalSubstitutionModal) return
    
    const { team, position, playerOut, reason } = exceptionalSubstitutionModal
    
    if (choice === 'exceptional') {
      // Show substitution dropdown with exceptional substitutes
      const exceptionalSubstitutes = getAvailableExceptionalSubstitutes(team, playerOut)
      if (exceptionalSubstitutes.length > 0) {
        // Find the court player element
        const courtPlayers = document.querySelectorAll('.court-player')
        let playerElement = null
        for (const el of courtPlayers) {
          const pos = el.querySelector('.court-player-position')?.textContent
          const num = el.textContent?.match(/\d+/)?.[0]
          if (pos === position && num === String(playerOut)) {
            playerElement = el
            break
          }
        }
        
        if (playerElement) {
          const rect = playerElement.getBoundingClientRect()
          setSubstitutionDropdown({
            team,
            position,
            playerNumber: playerOut,
            element: playerElement,
            x: rect.left + rect.width / 2,
            y: rect.bottom + 8,
            isExceptional: true,
            reason: reason
          })
        } else {
          setSubstitutionDropdown({
            team,
            position,
            playerNumber: playerOut,
            element: null,
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
            isExceptional: true,
            reason: reason
          })
        }
      }
      setExceptionalSubstitutionModal(null)
    } else if (choice === 'forfait') {
      // Handle forfait
      await handleForfait(team, reason)
      setExceptionalSubstitutionModal(null)
    }
  }, [exceptionalSubstitutionModal, getAvailableExceptionalSubstitutes, handleForfait])

  // Confirm substitution
  const confirmSubstitution = useCallback(async () => {
    if (!substitutionConfirm || !data?.set) return
    
    const { team, position, playerOut, playerIn, isInjury, isExceptional, isExpelled, isDisqualified } = substitutionConfirm
    
    // Get current lineup for this team in the current set
    const lineupEvents = data.events?.filter(e => 
      e.type === 'lineup' && 
      e.payload?.team === team && 
      e.setIndex === data.set.index
    ) || []
    const lineupEvent = lineupEvents.length > 0 ? lineupEvents[lineupEvents.length - 1] : null
    const currentLineup = lineupEvent?.payload?.lineup || {}
    
    // Create new lineup with substitution
    // First, clean currentLineup to ensure only valid positions
    const validPositions = ['I', 'II', 'III', 'IV', 'V', 'VI']
    const cleanedCurrentLineup = {}
    for (const pos of validPositions) {
      if (currentLineup[pos] !== undefined) {
        cleanedCurrentLineup[pos] = currentLineup[pos]
      }
    }
    
    const newLineup = { ...cleanedCurrentLineup }
    newLineup[position] = String(playerIn)
    
    // Ensure we only have exactly 6 positions (defensive check)
    const finalLineup = {}
    for (const pos of validPositions) {
      if (newLineup[pos] !== undefined) {
        finalLineup[pos] = newLineup[pos]
      }
    }
    
    // Save the updated lineup (mark as from substitution)
    const subSeq = await getNextSeq()
    const subEventId = await db.events.add({
      matchId,
      setIndex: data.set.index,
      type: 'lineup',
      payload: { team, lineup: finalLineup, fromSubstitution: true },
      ts: new Date().toISOString(),
      seq: subSeq
    })

    // Log the substitution event
    await logEvent('substitution', { 
      team, 
      position, 
      playerOut, 
      playerIn,
      isExceptional: isExceptional || false,
      isExpelled: isExpelled || false,
      isDisqualified: isDisqualified || false
    })
    
    // If injury or exceptional substitution, add automatic remarks
    if ((isInjury || isExceptional) && data?.set) {
      const setIndex = data.set.index
      const teamLabel = team === teamAKey ? 'A' : 'B'
      
      // Calculate game time (time since set start)
      const setStartTime = data.set.startTime ? new Date(data.set.startTime) : null
      const currentTime = new Date()
      let timeStr = '00:00'
      if (setStartTime) {
        const diffMs = currentTime.getTime() - setStartTime.getTime()
        const minutes = Math.floor(diffMs / 60000)
        const seconds = Math.floor((diffMs % 60000) / 1000)
        timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      }
      
      // Get current score - always put the interested team's score first
      const teamScore = team === 'home' ? data.set.homePoints : data.set.awayPoints
      const opponentScore = team === 'home' ? data.set.awayPoints : data.set.homePoints
      const opponentLabel = team === teamAKey ? teamBKey === 'home' ? 'A' : 'B' : teamAKey === 'home' ? 'A' : 'B'
      const scoreStr = `${teamLabel} ${teamScore}:${opponentScore} ${opponentLabel}`
      
      let remark = ''
      if (isInjury) {
        remark = `Set ${setIndex}, Team ${teamLabel}, Time ${timeStr}, Score ${scoreStr}, Player ${playerOut} substituted due to injury`
      } else if (isExceptional) {
        remark = `Set ${setIndex}, Team ${teamLabel}, Time ${timeStr}, Score ${scoreStr}, Player ${playerOut} exceptionally substituted by Player ${playerIn}`
      }
      
      if (remark) {
        const currentRemarks = data?.match?.remarks || ''
        const newRemarks = currentRemarks ? `${currentRemarks}\n${remark}` : remark
        await db.matches.update(matchId, { remarks: newRemarks })
      }
    }
    
    setSubstitutionConfirm(null)
    setLiberoDropdown(null) // Close libero dropdown when confirming substitution
    
    // Send substitution action to referee to show modal
    const teamName = team === 'home' ? data?.homeTeam?.shortName || data?.homeTeam?.name || 'Home' : data?.awayTeam?.shortName || data?.awayTeam?.name || 'Away'
    sendActionToReferee('substitution', {
      team,
      teamName,
      position,
      playerOut,
      playerIn,
      isExceptional: isExceptional || false
    })
    
    // Check if captain is on court after substitution
    // Check if the player leaving is the captain or court captain
    const teamPlayers = team === 'home' ? data?.homePlayers : data?.awayPlayers
    const leavingPlayer = teamPlayers?.find(p => p.number === playerOut)
    const isLeavingCaptain = leavingPlayer && (leavingPlayer.isCaptain || leavingPlayer.captain)
    const captainOnCourtField = team === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain'
    const currentCourtCaptain = data?.match?.[captainOnCourtField]
    const isLeavingCourtCaptain = currentCourtCaptain === playerOut
    
    if (isLeavingCaptain || isLeavingCourtCaptain) {
      setTimeout(() => {
        checkAndRequestCaptainOnCourt(team)
      }, 100)
    }
    
    // Check if this is an injury substitution for a libero - if so, log libero_unable and check for re-designation
    if (isInjury && playerOut) {
      const teamPlayers = team === 'home' ? data?.homePlayers : data?.awayPlayers
      const outPlayer = teamPlayers?.find(p => p.number === playerOut)
      if (outPlayer && outPlayer.libero) {
        // Log libero_unable event with reason='injury'
        await logEvent('libero_unable', {
          team,
          liberoNumber: playerOut,
          liberoType: outPlayer.libero,
          reason: 'injury'
        })
        // Use setTimeout to allow state to update first
        setTimeout(() => {
          checkLiberoRedesignation(team, playerOut, outPlayer.libero)
        }, 100)
      }
    }
  }, [substitutionConfirm, data?.set, data?.events, data?.match, data?.homePlayers, data?.awayPlayers, data?.homeTeam, data?.awayTeam, matchId, logEvent, teamAKey, checkLiberoRedesignation, sendActionToReferee])

  // Common modal position - all modals use the same position
  const getCommonModalPosition = useCallback((element, menuX, menuY) => {
    const rect = element?.getBoundingClientRect?.()
    if (rect) {
      return {
        x: rect.right + 30,
        y: rect.top + rect.height / 2
      }
    }
    return {
      x: menuX + 30,
      y: menuY
    }
  }, [])

  // Open substitution modal from action menu
  const openSubstitutionFromMenu = useCallback(() => {
    if (!playerActionMenu) return
    const { team, position, playerNumber } = playerActionMenu
    
    // Defensive check: ensure player can still be substituted
    if (!canPlayerBeSubstituted(team, playerNumber)) {
      alert('This player cannot be substituted (already completed a substitution cycle)')
      setPlayerActionMenu(null)
      return
    }
    
    const { element } = playerActionMenu
    const pos = getCommonModalPosition(element, playerActionMenu.x, playerActionMenu.y)
    setSubstitutionDropdown({
      team,
      position,
      playerNumber,
      element,
      x: pos.x,
      y: pos.y
    })
    setPlayerActionMenu(null)
  }, [playerActionMenu, getCommonModalPosition, canPlayerBeSubstituted])

  // Open libero modal from action menu
  const openLiberoFromMenu = useCallback(() => {
    if (!playerActionMenu) return
    const { team, position, playerNumber, element } = playerActionMenu
    const pos = getCommonModalPosition(element, playerActionMenu.x, playerActionMenu.y)
    setLiberoDropdown({
      team,
      position,
      playerNumber,
      element,
      x: pos.x,
      y: pos.y
    })
    setPlayerActionMenu(null)
  }, [playerActionMenu, getCommonModalPosition])

  // Open sanction modal from action menu
  const openSanctionFromMenu = useCallback(() => {
    if (!playerActionMenu) return
    const { team, position, playerNumber, element } = playerActionMenu
    const pos = getCommonModalPosition(element, playerActionMenu.x, playerActionMenu.y)
    setSanctionDropdown({
      team,
      type: 'player',
      playerNumber,
      position,
      element,
      x: pos.x,
      y: pos.y
    })
    setPlayerActionMenu(null)
  }, [playerActionMenu, getCommonModalPosition])

  // Open injury - same logic as expulsion/disqualification
  const openInjuryFromMenu = useCallback(async () => {
    if (!playerActionMenu || !data?.set) return
    const { team, position, playerNumber, element } = playerActionMenu
    
    // First, check if a legal substitution is possible (not exceptional)
    const legalSubstitutes = getAvailableSubstitutes(team, playerNumber, false)
    if (legalSubstitutes.length > 0) {
      // Legal substitution is possible - show substitution dropdown
    const pos = getCommonModalPosition(element, playerActionMenu.x, playerActionMenu.y)
    setSubstitutionDropdown({
      team,
      position,
      playerNumber,
      element,
      x: pos.x,
      y: pos.y,
      isInjury: true
    })
    setPlayerActionMenu(null)
    } else {
      // No legal substitution possible - check for exceptional substitution
      const exceptionalSubstitutes = getAvailableExceptionalSubstitutes(team, playerNumber)
      if (exceptionalSubstitutes.length > 0) {
        // Show modal to choose between exceptional substitution or forfait
        setPlayerActionMenu(null)
        setExceptionalSubstitutionModal({
          team,
          position,
          playerOut: playerNumber,
          reason: 'injury'
        })
      } else {
        // No exceptional substitution possible - automatic forfait
        setPlayerActionMenu(null)
        await handleForfait(team, 'injury')
      }
    }
  }, [playerActionMenu, data?.set, getAvailableSubstitutes, getAvailableExceptionalSubstitutes, handleForfait, getCommonModalPosition])

  const cancelSubstitution = useCallback(() => {
    setSubstitutionDropdown(null)
    setLiberoDropdown(null) // Close both together
  }, [])

  const cancelSubstitutionConfirm = useCallback(() => {
    setSubstitutionConfirm(null)
    setLiberoDropdown(null) // Close libero dropdown when canceling substitution
  }, [])

  // Handle injury - same logic as expulsion/disqualification
  const handleInjury = useCallback(async () => {
    if (!injuryDropdown || !data?.set) return
    
    const { team, position, playerNumber } = injuryDropdown
    
    // First, check if a legal substitution is possible (not exceptional)
    const legalSubstitutes = getAvailableSubstitutes(team, playerNumber, false)
    if (legalSubstitutes.length > 0) {
      // Legal substitution is possible - show substitution dropdown
      setInjuryDropdown(null)
      const rect = injuryDropdown.element?.getBoundingClientRect?.()
      if (rect) {
        setSubstitutionDropdown({
          team,
          position,
          playerNumber,
          element: injuryDropdown.element,
          x: rect.right - 8,
          y: rect.bottom + 8
        })
      }
    } else {
      // No legal substitution possible - check for exceptional substitution
      const exceptionalSubstitutes = getAvailableExceptionalSubstitutes(team, playerNumber)
      if (exceptionalSubstitutes.length > 0) {
        // Show modal to choose between exceptional substitution or forfait
        setInjuryDropdown(null)
        setExceptionalSubstitutionModal({
          team,
          position,
          playerOut: playerNumber,
          reason: 'injury'
        })
      } else {
        // No exceptional substitution possible - automatic forfait
        setInjuryDropdown(null)
        await handleForfait(team, 'injury')
      }
    }
  }, [injuryDropdown, data?.set, getAvailableSubstitutes, getAvailableExceptionalSubstitutes, handleForfait])

  // Cancel injury dropdown
  const cancelInjury = useCallback(() => {
    setInjuryDropdown(null)
  }, [])

  // Show sanction confirmation modal
  const showSanctionConfirm = useCallback((sanctionType) => {
    if (!sanctionDropdown) return
    setSanctionConfirmModal({
      team: sanctionDropdown.team,
      type: sanctionDropdown.type,
      playerNumber: sanctionDropdown.playerNumber,
      position: sanctionDropdown.position,
      role: sanctionDropdown.role,
      sanctionType
    })
    setSanctionDropdown(null)
  }, [sanctionDropdown])

  // Cancel sanction dropdown
  const cancelSanction = useCallback(() => {
    setSanctionDropdown(null)
  }, [])

  // Cancel sanction confirmation
  const cancelSanctionConfirm = useCallback(() => {
    setSanctionConfirmModal(null)
  }, [])

  // Check if a player has a specific sanction type
  const playerHasSanctionType = useCallback((teamKey, playerNumber, sanctionType) => {
    if (!data?.events) return false
    
    const hasSanction = data.events.some(e => {
      const isSanction = e.type === 'sanction'
      const teamMatch = e.payload?.team === teamKey
      const playerMatch = e.payload?.playerNumber === playerNumber || 
                         String(e.payload?.playerNumber) === String(playerNumber) ||
                         Number(e.payload?.playerNumber) === Number(playerNumber)
      const typeMatch = e.payload?.type === sanctionType
      
      return isSanction && teamMatch && playerMatch && typeMatch
    })
    
    return hasSanction
  }, [data?.events])

  // Get player's current highest sanction
  const getPlayerSanctionLevel = useCallback((teamKey, playerNumber) => {
    if (!data?.events) return null
    
    // Get all FORMAL sanctions for this player in this match
    // NOTE: delay_warning and delay_penalty are SEPARATE from the formal escalation path
    // A player can have delay warnings AND formal warnings independently
    // Convert playerNumber to both string and number for comparison (in case of type mismatch)
    const playerSanctions = data.events.filter(e => {
      const isSanction = e.type === 'sanction'
      const teamMatch = e.payload?.team === teamKey
      const playerMatch = e.payload?.playerNumber === playerNumber || 
                         String(e.payload?.playerNumber) === String(playerNumber) ||
                         Number(e.payload?.playerNumber) === Number(playerNumber)
      const isFormalSanction = ['warning', 'penalty', 'expulsion', 'disqualification'].includes(e.payload?.type)
      
      return isSanction && teamMatch && playerMatch && isFormalSanction
    })
    
    if (playerSanctions.length === 0) return null

    // Return the highest sanction level
    const levels = { warning: 1, penalty: 2, expulsion: 3, disqualification: 4 }
    const highest = playerSanctions.reduce((max, s) => {
      const level = levels[s.payload?.type] || 0
      return level > max ? level : max
    }, 0)

    const result = Object.keys(levels).find(key => levels[key] === highest)
    return result
  }, [data?.events])

  // Check if team has received a formal warning (only one per team per game)
  const teamHasFormalWarning = useCallback((teamKey) => {
    if (!data?.events) return false
    
    // Check all sets for this match for FORMAL warnings only
    // NOTE: delay_warning is separate and doesn't count as a formal warning
    const teamSanctions = data.events.filter(e => 
      e.type === 'sanction' && 
      e.payload?.team === teamKey &&
      e.payload?.type === 'warning' // This is formal warning, NOT delay_warning
    )
    
    return teamSanctions.length > 0
  }, [data?.events])

  // Get sanctions for a player or official
  const getPlayerSanctions = useCallback((teamKey, playerNumber, role = null) => {
    if (!data?.events) return []
    
    const sanctions = data.events.filter(e => {
      if (e.type !== 'sanction') return false
      if (e.payload?.team !== teamKey) return false
      
      // For player sanctions
      if (playerNumber !== null && playerNumber !== undefined) {
        // Convert both to strings for comparison to handle number/string mismatches
        const eventPlayerNumber = e.payload?.playerNumber
        const matchesPlayer = String(eventPlayerNumber) === String(playerNumber)
        const isFormalSanction = ['warning', 'penalty', 'expulsion', 'disqualification'].includes(e.payload?.type)
        return matchesPlayer && isFormalSanction
      }
      
      // For official sanctions
      if (role) {
        return e.payload?.role === role &&
               ['warning', 'penalty', 'expulsion', 'disqualification'].includes(e.payload?.type)
      }
      
      return false
    })
    
    return sanctions
  }, [data?.events])

  // Confirm player sanction
  const confirmPlayerSanction = useCallback(async () => {
    if (!sanctionConfirmModal || !data?.set) return
    
    const { team, type, playerNumber, position, role, sanctionType } = sanctionConfirmModal
    
    // Validate that we're not giving the same sanction type again
    if (playerNumber) {
      const hasThisSanction = playerHasSanctionType(team, playerNumber, sanctionType)
      const teamWarning = teamHasFormalWarning(team)

      // Prevent giving the same sanction type again
      if (hasThisSanction) {
        alert(`Player ${playerNumber} already has a ${sanctionType}. A player cannot receive the same sanction type twice.`)
        setSanctionConfirmModal(null)
        return
      }

      // Special rule for warning: can only be given if team hasn't been warned (player can have other sanctions)
      if (sanctionType === 'warning' && teamWarning) {
        alert(`Warning cannot be given because the team has already been warned.`)
        setSanctionConfirmModal(null)
        return
      }
    }
    
    // If expulsion or disqualification for a court player, need to handle substitution
    if ((sanctionType === 'expulsion' || sanctionType === 'disqualification') && type === 'player' && playerNumber && position) {
      // Log the sanction event first
      await logEvent('sanction', {
        team,
        type: sanctionType,
        playerType: type,
        playerNumber,
        position,
        role
      })
      
      // Check if this is a libero - if so, log libero_unable
      const teamPlayers = team === 'home' ? data?.homePlayers : data?.awayPlayers
      const player = teamPlayers?.find(p => p.number === playerNumber)
      if (player && player.libero) {
        await logEvent('libero_unable', {
          team,
          liberoNumber: playerNumber,
          liberoType: player.libero,
          reason: sanctionType === 'expulsion' ? 'expulsion' : 'disqualification'
        })
      }
      
      // Close the confirmation modal
      setSanctionConfirmModal(null)
      
      // Check if the player being expelled/disqualified is the captain or court captain
      const sanctionedPlayer = teamPlayers?.find(p => p.number === playerNumber)
      const isSanctionedCaptain = sanctionedPlayer && (sanctionedPlayer.isCaptain || sanctionedPlayer.captain)
      const captainOnCourtField = team === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain'
      const currentCourtCaptain = data?.match?.[captainOnCourtField]
      const isSanctionedCourtCaptain = currentCourtCaptain === playerNumber
      
      // First, check if a legal substitution is possible (not exceptional)
      const legalSubstitutes = getAvailableSubstitutes(team, playerNumber, false)
      if (legalSubstitutes.length > 0) {
        // Legal substitution is possible - show substitution dropdown
        const courtPlayers = document.querySelectorAll('.court-player')
        let playerElement = null
        for (const el of courtPlayers) {
          const pos = el.querySelector('.court-player-position')?.textContent
          const num = el.textContent?.match(/\d+/)?.[0]
          if (pos === position && num === String(playerNumber)) {
            playerElement = el
            break
          }
        }
        
        if (playerElement) {
          const rect = playerElement.getBoundingClientRect()
          setSubstitutionDropdown({
            team,
            position,
            playerNumber,
            element: playerElement,
            x: rect.left + rect.width / 2,
            y: rect.bottom + 8
          })
        } else {
          setSubstitutionDropdown({
            team,
            position,
            playerNumber,
            element: null,
            x: window.innerWidth / 2,
            y: window.innerHeight / 2
          })
        }
      } else {
        // No legal substitution possible - check for exceptional substitution
        const exceptionalSubstitutes = getAvailableExceptionalSubstitutes(team, playerNumber)
        if (exceptionalSubstitutes.length > 0) {
          // Show modal to choose between exceptional substitution or forfait
          setExceptionalSubstitutionModal({
            team,
            position,
            playerOut: playerNumber,
            reason: sanctionType === 'expulsion' ? 'expulsion' : 'disqualification'
          })
        } else {
          // No exceptional substitution possible - automatic forfait
          await handleForfait(team, sanctionType === 'expulsion' ? 'expulsion' : 'disqualification')
        }
      }
      
      // Check if captain is on court after substitution (if substitution happened) or forfait
      if (isSanctionedCaptain || isSanctionedCourtCaptain) {
        setTimeout(() => {
          checkAndRequestCaptainOnCourt(team)
        }, 100)
      }
    } else if (sanctionType === 'expulsion' || sanctionType === 'disqualification') {
      // Expulsion/disqualification for bench players or officials - just log the sanction
      await logEvent('sanction', {
        team,
        type: sanctionType,
        playerType: type,
        playerNumber,
        position,
        role
      })
      
      setSanctionConfirmModal(null)
      
      // Check if this is a libero - if so, log libero_unable and check for re-designation
      if (type === 'libero' && playerNumber) {
        const teamPlayers = team === 'home' ? data?.homePlayers : data?.awayPlayers
        const liberoPlayer = teamPlayers?.find(p => p.number === playerNumber)
        if (liberoPlayer && liberoPlayer.libero) {
          // Log libero_unable event with reason based on sanction type
          await logEvent('libero_unable', {
            team,
            liberoNumber: playerNumber,
            liberoType: liberoPlayer.libero,
            reason: sanctionType === 'expulsion' ? 'expulsion' : 'disqualification'
          })
          // Use setTimeout to allow state to update first
          setTimeout(() => {
            checkLiberoRedesignation(team, playerNumber, liberoPlayer.libero)
          }, 100)
        }
      }
    } else {
      // Regular sanction (warning or penalty)
      await logEvent('sanction', {
        team,
        type: sanctionType,
        playerType: type,
        playerNumber,
        position,
        role
      })
      
      // If penalty, award point to the other team (but only if lineups are set)
      if (sanctionType === 'penalty') {
        // Check if both lineups are set before awarding point
        const homeTeamKey = leftIsHome ? 'home' : 'away'
        const awayTeamKey = leftIsHome ? 'away' : 'home'
        
        const homeLineupSet = data.events?.some(e => 
          e.type === 'lineup' && 
          e.payload?.team === homeTeamKey && 
          e.setIndex === data.set.index &&
          e.payload?.isInitial
        )
        const awayLineupSet = data.events?.some(e => 
          e.type === 'lineup' && 
          e.payload?.team === awayTeamKey && 
          e.setIndex === data.set.index &&
          e.payload?.isInitial
        )
        
        setSanctionConfirmModal(null)
        
        if (homeLineupSet && awayLineupSet) {
          // Both lineups are set - award point immediately
          const otherTeam = team === 'home' ? 'away' : 'home'
          const otherSide = mapTeamKeyToSide(otherTeam)
          await handlePoint(otherSide)
        } else {
          // Lineups not set - show message
          alert('Penalty recorded. Point will be awarded after both teams set their lineups.')
        }
      } else {
        setSanctionConfirmModal(null)
      }
    }
  }, [sanctionConfirmModal, data?.set, data?.events, logEvent, getAvailableSubstitutes, getAvailableExceptionalSubstitutes, mapTeamKeyToSide, handlePoint, leftIsHome, getPlayerSanctionLevel, playerHasSanctionType, teamHasFormalWarning])

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

  // Handle libero in player selection
  const handleLiberoInPlayerSelect = useCallback(async (position, playerNumber) => {
    if (!liberoInDropdown || !data?.set) return
    
    const { team } = liberoInDropdown
    
    // Get available liberos
    const teamPlayers = team === 'home' ? data?.homePlayers : data?.awayPlayers
    const liberos = teamPlayers?.filter(p => p.libero && p.libero !== '') || []
    const availableLiberos = liberos.filter(libero => !isLiberoUnable(team, libero.number))
    
    if (availableLiberos.length === 0) {
      alert('No available liberos')
      setLiberoInDropdown(null)
      return
    }
    
    // If only one libero, use it; otherwise show selection
    let liberoToUse = availableLiberos[0]
    if (availableLiberos.length > 1) {
      // For now, use the first available libero
      // Could enhance to show libero selection if needed
      liberoToUse = availableLiberos[0]
    }
    
    // Liberos can only enter back row positions (I, V, VI)
    // Since user selected a player in I (not serving), II, or III, we'll enter libero in position I
    const liberoEntryPosition = 'I'
    
    // Set up libero confirm similar to existing flow
    setLiberoConfirm({
      team: team,
      position: liberoEntryPosition,
      playerOut: playerNumber,
      liberoIn: liberoToUse.libero
    })
    setLiberoInDropdown(null)
  }, [liberoInDropdown, data?.set, data?.homePlayers, data?.awayPlayers, isLiberoUnable])

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
      return
    }
    
    // Check if libero is unable to play
    if (isLiberoUnable(team, liberoPlayer.number)) {
      alert('This libero is unable to play (injured, expelled, disqualified, or declared unable)')
      setLiberoConfirm(null)
      setLiberoDropdown(null)
      return
    }
    
    // Create new lineup with libero entry
    // First, clean currentLineup to ensure only valid positions
    const validPositions = ['I', 'II', 'III', 'IV', 'V', 'VI']
    const cleanedCurrentLineup = {}
    for (const pos of validPositions) {
      if (currentLineup[pos] !== undefined) {
        cleanedCurrentLineup[pos] = currentLineup[pos]
      }
    }
    
    const newLineup = { ...cleanedCurrentLineup }
    newLineup[position] = String(liberoPlayer.number)
    
    // Ensure we only have exactly 6 positions (defensive check)
    const finalLineup = {}
    for (const pos of validPositions) {
      if (newLineup[pos] !== undefined) {
        finalLineup[pos] = newLineup[pos]
      }
    }
    
    // Save the updated lineup with libero substitution info
    const nextSeq = await getNextSeq()
    
    const liberoEntryEventId = await db.events.add({
      matchId,
      setIndex: data.set.index,
      type: 'lineup',
      payload: { 
        team, 
        lineup: finalLineup,
        liberoSubstitution: {
          position,
          liberoNumber: liberoPlayer.number,
          playerNumber: playerOut,
          liberoType: liberoIn
        }
      },
      ts: new Date().toISOString(),
      seq: nextSeq
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
    
    // Check if captain is on court after libero entry
    // The playerOut is leaving, check if they're captain
    // Reuse teamPlayers variable already declared above
    const leavingPlayer = teamPlayers?.find(p => p.number === playerOut)
    const isLeavingCaptain = leavingPlayer && (leavingPlayer.isCaptain || leavingPlayer.captain)
    const captainOnCourtField = team === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain'
    const currentCourtCaptain = data?.match?.[captainOnCourtField]
    const isLeavingCourtCaptain = currentCourtCaptain === playerOut
    
    if (isLeavingCaptain || isLeavingCourtCaptain) {
      setTimeout(() => {
        checkAndRequestCaptainOnCourt(team)
      }, 100)
    }
    setSubstitutionDropdown(null) // Close substitution dropdown if open
    setLiberoDropdown(null) // Close libero dropdown if open
  }, [liberoConfirm, data?.set, data?.events, data?.homePlayers, data?.awayPlayers, matchId, logEvent, getNextSeq, isLiberoUnable])

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

    // Use the selected libero from availableLiberos if present, otherwise use the original values
    const { team, position, playerNumber, availableLiberos, selectedLiberoIndex } = liberoReentryModal
    const selectedLibero = availableLiberos && availableLiberos[selectedLiberoIndex]
    const liberoNumber = selectedLibero ? selectedLibero.number : liberoReentryModal.liberoNumber
    const liberoType = selectedLibero ? selectedLibero.type : liberoReentryModal.liberoType
    
    // Check if libero is unable to play
    if (isLiberoUnable(team, liberoNumber)) {
      alert('This libero is unable to play (injured, expelled, disqualified, or declared unable)')
      setLiberoReentryModal(null)
      return
    }
    
    const playerOut = playerNumber // For consistency with other libero entry logic
    
    // Get current lineup for this team in the current set
    const lineupEvents = data.events?.filter(e => 
      e.type === 'lineup' && 
      e.payload?.team === team && 
      e.setIndex === data.set.index
    ) || []
    const lineupEvent = lineupEvents.length > 0 ? lineupEvents[lineupEvents.length - 1] : null
    const currentLineup = lineupEvent?.payload?.lineup || {}
    
    // Create new lineup with libero re-entry
    // First, clean currentLineup to ensure only valid positions
    const validPositions = ['I', 'II', 'III', 'IV', 'V', 'VI']
    const cleanedCurrentLineup = {}
    for (const pos of validPositions) {
      if (currentLineup[pos] !== undefined) {
        cleanedCurrentLineup[pos] = currentLineup[pos]
      }
    }
    
    const newLineup = { ...cleanedCurrentLineup }
    newLineup[position] = String(liberoNumber)
    
    // Ensure we only have exactly 6 positions (defensive check)
    const finalLineup = {}
    for (const pos of validPositions) {
      if (newLineup[pos] !== undefined) {
        finalLineup[pos] = newLineup[pos]
      }
    }
    
    // Save the updated lineup with libero substitution info
    const liberoExitSeq = await getNextSeq()
    const liberoExitEventId = await db.events.add({
      matchId,
      setIndex: data.set.index,
      type: 'lineup',
      payload: { 
        team, 
        lineup: finalLineup,
        liberoSubstitution: {
          position,
          liberoNumber: liberoNumber,
          playerNumber: playerOut,
          liberoType: liberoType
        }
      },
      ts: new Date().toISOString(),
      seq: liberoExitSeq
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
    
    // Check if captain is on court after libero reentry (playerOut is leaving)
    const teamPlayers = team === 'home' ? data?.homePlayers : data?.awayPlayers
    const leavingPlayer = teamPlayers?.find(p => p.number === playerOut)
    const isLeavingCaptain = leavingPlayer && (leavingPlayer.isCaptain || leavingPlayer.captain)
    const captainOnCourtField = team === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain'
    const currentCourtCaptain = data?.match?.[captainOnCourtField]
    const isLeavingCourtCaptain = currentCourtCaptain === playerOut
    
    if (isLeavingCaptain || isLeavingCourtCaptain) {
      setTimeout(() => {
        checkAndRequestCaptainOnCourt(team)
      }, 100)
    }
  }, [liberoReentryModal, data?.set, data?.events, data?.homePlayers, data?.awayPlayers, data?.match, matchId, logEvent, isLiberoUnable, checkAndRequestCaptainOnCourt])

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
      alert('Original player not found for this libero. Please update lineup manually.')
      return
    }
    
    // First, clean currentLineup to ensure only valid positions
    const validPositions = ['I', 'II', 'III', 'IV', 'V', 'VI']
    const cleanedCurrentLineup = {}
    for (const pos of validPositions) {
      if (currentLineup[pos] !== undefined) {
        cleanedCurrentLineup[pos] = currentLineup[pos]
      }
    }
    
    // Restore the original player
    const newLineup = { ...cleanedCurrentLineup }
    
    // Check if the original player is already on court in another position
    // If so, remove them from that position first to avoid duplicates
    for (const [pos, playerNum] of Object.entries(newLineup)) {
      if (String(playerNum) === String(originalPlayerNumber) && pos !== liberoOnCourt.position) {
        // The original player is already in another position - remove them from there
        // This can happen if the team rotated while the libero was in
        delete newLineup[pos]
        break
      }
    }
    
    // Now set the original player in the libero's position
    newLineup[liberoOnCourt.position] = String(originalPlayerNumber)
    
    // Ensure we only have exactly 6 positions (defensive check)
    const finalLineup = {}
    for (const pos of validPositions) {
      if (newLineup[pos] !== undefined) {
        finalLineup[pos] = newLineup[pos]
      }
    }
    
    // Save the updated lineup (explicitly without libero substitution)
    const liberoClearSeq = await getNextSeq()
    const liberoClearEventId = await db.events.add({
      matchId,
      setIndex: data.set.index,
      type: 'lineup',
      payload: { 
        team: teamKey, 
        lineup: finalLineup,
        liberoSubstitution: null // Explicitly clear libero substitution
      },
      ts: new Date().toISOString(),
      seq: liberoClearSeq
    })

    // Log the libero exit event
    await logEvent('libero_exit', {
      team: teamKey,
      position: liberoOnCourt.position,
      liberoOut: liberoOnCourt.liberoNumber,
      playerIn: originalPlayerNumber,
      liberoType: liberoOnCourt.liberoType
    })
    
    // Check if the libero leaving is the court captain
    const captainOnCourtField = teamKey === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain'
    const currentCourtCaptain = data?.match?.[captainOnCourtField]
    if (currentCourtCaptain === liberoOnCourt.liberoNumber) {
      setTimeout(() => {
        checkAndRequestCaptainOnCourt(teamKey)
      }, 100)
    }
  }, [rallyStatus, mapSideToTeamKey, getLiberoOnCourt, hasPointSinceLastLiberoExchange, data?.events, data?.set, data?.match, matchId, logEvent, data?.homePlayers, data?.awayPlayers, checkAndRequestCaptainOnCourt])

  // Handle libero re-designation
  const confirmLiberoRedesignation = useCallback(async (newLiberoNumber) => {
    if (!liberoRedesignationModal || !data?.set) return
    
    const { team, unableLiberoNumber, unableLiberoType } = liberoRedesignationModal
    
    // Log the libero_unable event if not already logged (with reason='declared' if not specified)
    const hasUnableEvent = data?.events?.some(e => 
      e.type === 'libero_unable' && 
      e.payload?.team === team &&
      e.payload?.liberoNumber === unableLiberoNumber
    )
    
    if (!hasUnableEvent) {
      await logEvent('libero_unable', {
        team,
        liberoNumber: unableLiberoNumber,
        liberoType: unableLiberoType,
        reason: 'declared' // Default to declared if not specified
      })
    }
    
    // Log the re-designation event
    await logEvent('libero_redesignation', {
      team,
      unableLiberoNumber,
      unableLiberoType,
      newLiberoNumber
    })
    
    // Record in remarks
    const teamLabel = team === teamAKey ? 'A' : 'B'
    const setIndex = data.set.index
    const setStartTime = data.set.startTime ? new Date(data.set.startTime) : null
    const currentTime = new Date()
    let timeStr = '00:00'
    if (setStartTime) {
      const diffMs = currentTime.getTime() - setStartTime.getTime()
      const minutes = Math.floor(diffMs / 60000)
      const seconds = Math.floor((diffMs % 60000) / 1000)
      timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    }
    
    const remark = `Set ${setIndex}, Team ${teamLabel}, Time ${timeStr}, Player ${newLiberoNumber} re-designated as Libero (replacing ${unableLiberoNumber})`
    const currentRemarks = data?.match?.remarks || ''
    const newRemarks = currentRemarks ? `${currentRemarks}\n${remark}` : remark
    await db.matches.update(matchId, { remarks: newRemarks })
    
    setLiberoRedesignationModal(null)
  }, [liberoRedesignationModal, data?.set, data?.events, data?.match, logEvent, teamAKey, matchId])

  // Confirm marking libero as unable
  const confirmLiberoUnable = useCallback(async () => {
    if (!liberoUnableModal || !data?.set) return
    
    const { team, liberoNumber, liberoType } = liberoUnableModal
    
    try {
      // Mark libero as unable (declared by coach)
      await logEvent('libero_unable', {
        team,
        liberoNumber,
        liberoType,
        reason: 'declared'
      })
      
      // Check if re-designation is needed
      setTimeout(() => {
        checkLiberoRedesignation(team, liberoNumber, liberoType)
      }, 100)
      
      setLiberoUnableModal(null)
    } catch (error) {
      // Silently handle error
    }
  }, [liberoUnableModal, data?.set, logEvent, checkLiberoRedesignation])

  // Handle libero in button click
  const handleLiberoIn = useCallback((side, event) => {
    if (rallyStatus !== 'idle') return
    
    const teamKey = mapSideToTeamKey(side)
    const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
    const liberos = teamPlayers?.filter(p => p.libero && p.libero !== '') || []
    
    // Check if a libero is already on court
    const liberoOnCourt = getLiberoOnCourt(teamKey)
    if (liberoOnCourt) {
      alert('A libero is already on court')
      return
    }
    
    // Check if team has any liberos
    if (liberos.length === 0) {
      alert('No liberos available')
      return
    }
    
    // Check if any libero is available (not unable)
    const availableLiberos = liberos.filter(libero => !isLiberoUnable(teamKey, libero.number))
    if (availableLiberos.length === 0) {
      alert('No available liberos (all are unable to play)')
      return
    }
    
    // Get button position for dropdown
    const rect = event.currentTarget.getBoundingClientRect()
    setLiberoInDropdown({
      team: teamKey,
      side: side,
      element: event.currentTarget,
      x: rect.left + rect.width / 2,
      y: rect.bottom + 8
    })
  }, [rallyStatus, data?.homePlayers, data?.awayPlayers, getLiberoOnCourt, isLiberoUnable, mapSideToTeamKey, getCurrentServe, getTeamLineupState])

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
    
    // Check if either libero is unable to play
    if (isLiberoUnable(teamKey, liberoOnCourt.liberoNumber)) {
      alert('The libero currently on court is unable to play (injured, expelled, disqualified, or declared unable)')
      return
    }
    
    if (isLiberoUnable(teamKey, otherLibero.number)) {
      alert('The other libero is unable to play (injured, expelled, disqualified, or declared unable)')
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
    const liberoExchangeSeq = await getNextSeq()
    const liberoExchangeEventId = await db.events.add({
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
      ts: new Date().toISOString(),
      seq: liberoExchangeSeq
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
  }, [rallyStatus, mapSideToTeamKey, getLiberoOnCourt, hasPointSinceLastLiberoExchange, data?.events, data?.set, data?.homePlayers, data?.awayPlayers, matchId, logEvent, isLiberoUnable])

  // Keyboard shortcuts handler
  useEffect(() => {
    if (!keybindingsEnabled) return

    const handleKeyDown = (e) => {
      // Don't handle if editing key bindings
      if (editingKey) return
      // Don't handle if typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return
      // Don't handle if options modal is open
      if (showOptionsInMenu || keybindingsModalOpen) return

      const key = e.key

      // Check for modal confirmations first (Enter/Escape)
      // These modals need a decision - don't allow Escape to close them
      const hasDecisionModal = substitutionConfirm || liberoConfirm || sanctionConfirmModal ||
        accidentalRallyConfirmModal || accidentalPointConfirmModal || undoConfirm ||
        replayRallyConfirm || liberoRotationModal || liberoReentryModal

      // Confirm key (Enter)
      if (key === keyBindings.confirm) {
        // Start rally if idle and no modals
        if (!hasDecisionModal && rallyStatus === 'idle') {
          e.preventDefault()
          handleStartRally()
          return
        }
        // Confirm modals
        if (accidentalRallyConfirmModal) {
          e.preventDefault()
          accidentalRallyConfirmModal.onConfirm()
          return
        }
        if (accidentalPointConfirmModal) {
          e.preventDefault()
          accidentalPointConfirmModal.onConfirm()
          return
        }
        if (substitutionConfirm) {
          e.preventDefault()
          confirmSubstitution()
          return
        }
        if (liberoConfirm) {
          e.preventDefault()
          confirmLibero()
          return
        }
        if (undoConfirm) {
          e.preventDefault()
          handleUndo()
          return
        }
        if (replayRallyConfirm) {
          e.preventDefault()
          handleReplayRally()
          return
        }
      }

      // Cancel key (Escape) - only close non-decision modals
      if (key === keyBindings.cancel) {
        // Close dropdowns and menus
        if (playerActionMenu) {
          e.preventDefault()
          setPlayerActionMenu(null)
          return
        }
        if (benchPlayerActionMenu) {
          e.preventDefault()
          setBenchPlayerActionMenu(null)
          return
        }
        if (liberoDropdown) {
          e.preventDefault()
          setLiberoDropdown(null)
          return
        }
        if (liberoInDropdown) {
          e.preventDefault()
          setLiberoInDropdown(null)
          return
        }
        if (sanctionDropdown) {
          e.preventDefault()
          setSanctionDropdown(null)
          return
        }
        if (timeoutModal) {
          e.preventDefault()
          setTimeoutModal(null)
          return
        }
        // Don't close decision modals with Escape
        return
      }

      // Don't process other keys if a modal is open
      if (hasDecisionModal || timeoutModal || lineupModal || menuModal) return

      // Point keys
      if (key === keyBindings.pointLeft && rallyStatus === 'in_play') {
        e.preventDefault()
        handlePoint('left')
        return
      }
      if (key === keyBindings.pointRight && rallyStatus === 'in_play') {
        e.preventDefault()
        handlePoint('right')
        return
      }

      // Timeout keys (only when idle)
      if (key === keyBindings.timeoutLeft && rallyStatus === 'idle') {
        e.preventDefault()
        handleTimeout('left')
        return
      }
      if (key === keyBindings.timeoutRight && rallyStatus === 'idle') {
        e.preventDefault()
        handleTimeout('right')
        return
      }

      // Exchange libero keys (only when idle)
      if (key === keyBindings.exchangeLiberoLeft && rallyStatus === 'idle') {
        e.preventDefault()
        handleExchangeLibero('left')
        return
      }
      if (key === keyBindings.exchangeLiberoRight && rallyStatus === 'idle') {
        e.preventDefault()
        handleExchangeLibero('right')
        return
      }

      // Undo key
      if (key === keyBindings.undo && rallyStatus === 'idle') {
        e.preventDefault()
        handleUndo()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    keybindingsEnabled, keyBindings, editingKey, showOptionsInMenu, keybindingsModalOpen,
    rallyStatus, handleStartRally, handlePoint, handleTimeout, handleExchangeLibero, handleUndo,
    playerActionMenu, benchPlayerActionMenu, liberoDropdown, liberoInDropdown, sanctionDropdown,
    timeoutModal, lineupModal, menuModal,
    substitutionConfirm, liberoConfirm, sanctionConfirmModal, accidentalRallyConfirmModal,
    accidentalPointConfirmModal, undoConfirm, replayRallyConfirm, liberoRotationModal, liberoReentryModal,
    confirmSubstitution, confirmLibero, handleReplayRally
  ])

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

  // Check if referees are connected (heartbeat within last 15 seconds)
  // Must be before any early returns to comply with Rules of Hooks
  const isReferee1Connected = useMemo(() => {
    if (!data?.match?.lastReferee1Heartbeat) return false
    const lastHeartbeat = new Date(data.match.lastReferee1Heartbeat).getTime()
    const currentTime = new Date().getTime()
    return (currentTime - lastHeartbeat) < 15000 // 15 seconds threshold
  }, [data?.match?.lastReferee1Heartbeat, now])

  const isReferee2Connected = useMemo(() => {
    if (!data?.match?.lastReferee2Heartbeat) return false
    const lastHeartbeat = new Date(data.match.lastReferee2Heartbeat).getTime()
    const currentTime = new Date().getTime()
    return (currentTime - lastHeartbeat) < 15000 // 15 seconds threshold
  }, [data?.match?.lastReferee2Heartbeat, now])

  const isAnyRefereeConnected = isReferee1Connected || isReferee2Connected
  const refereeConnectionEnabled = data?.match?.refereeConnectionEnabled !== false
  const homeTeamConnectionEnabled = data?.match?.homeTeamConnectionEnabled !== false
  const awayTeamConnectionEnabled = data?.match?.awayTeamConnectionEnabled !== false
  
  // Handle captain on court selection
  const handleSelectCaptainOnCourt = useCallback(async (playerNumber) => {
    if (!captainOnCourtModal || !matchId) return
    
    const { team } = captainOnCourtModal
    const field = team === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain'
    
    // Save the selected captain on court
    await db.matches.update(matchId, { [field]: playerNumber })
    
    setCaptainOnCourtModal(null)
  }, [captainOnCourtModal, matchId])
  
  // Handle cancel (no captain selected)
  const handleCancelCaptainOnCourt = useCallback(() => {
    setCaptainOnCourtModal(null)
  }, [])

  // Check if bench teams are connected (heartbeat within last 15 seconds)
  const isHomeTeamConnected = useMemo(() => {
    if (!data?.match?.lastHomeTeamHeartbeat) return false
    const lastHeartbeat = new Date(data.match.lastHomeTeamHeartbeat).getTime()
    const currentTime = new Date().getTime()
    return (currentTime - lastHeartbeat) < 15000 // 15 seconds threshold
  }, [data?.match?.lastHomeTeamHeartbeat, now])

  const isAwayTeamConnected = useMemo(() => {
    if (!data?.match?.lastAwayTeamHeartbeat) return false
    const lastHeartbeat = new Date(data.match.lastAwayTeamHeartbeat).getTime()
    const currentTime = new Date().getTime()
    return (currentTime - lastHeartbeat) < 15000 // 15 seconds threshold
  }, [data?.match?.lastAwayTeamHeartbeat, now])

  // Helper function to get connection status and color
  const getConnectionStatus = useCallback((type) => {
    if (type === 'referee') {
      if (!refereeConnectionEnabled) {
        return { status: 'disabled', color: '#6b7280' } // grey
      }
      if (isReferee1Connected || isReferee2Connected) {
        return { status: 'connected', color: '#22c55e' } // green
      }
      // Enabled but not connected
      return { status: 'not_connected', color: '#eab308' } // yellow
    } else if (type === 'teamA') {
      if (!homeTeamConnectionEnabled) {
        return { status: 'disabled', color: '#6b7280' } // grey
      }
      const hasPin = !!data?.match?.homeTeamPin
      if (!hasPin) {
        return { status: 'error', color: '#ef4444' } // red - no PIN configured
      }
      if (isHomeTeamConnected) {
        return { status: 'connected', color: '#22c55e' } // green
      }
      // Enabled, has PIN, but not connected
      return { status: 'not_connected', color: '#eab308' } // yellow
    } else if (type === 'teamB') {
      if (!awayTeamConnectionEnabled) {
        return { status: 'disabled', color: '#6b7280' } // grey
      }
      const hasPin = !!data?.match?.awayTeamPin
      if (!hasPin) {
        return { status: 'error', color: '#ef4444' } // red - no PIN configured
      }
      if (isAwayTeamConnected) {
        return { status: 'connected', color: '#22c55e' } // green
      }
      // Enabled, has PIN, but not connected
      return { status: 'not_connected', color: '#eab308' } // yellow
    }
    return { status: 'error', color: '#ef4444' } // red - unknown
  }, [refereeConnectionEnabled, isReferee1Connected, isReferee2Connected, homeTeamConnectionEnabled, awayTeamConnectionEnabled, isHomeTeamConnected, isAwayTeamConnected, data?.match])

  const handleRefereeConnectionToggle = useCallback(async (enabled) => {
    if (!matchId) return
    try {
      await db.matches.update(matchId, { refereeConnectionEnabled: enabled })
    } catch (error) {
      // Silently handle error
    }
  }, [matchId])

  const handleHomeTeamConnectionToggle = useCallback(async (enabled) => {
    if (!matchId) return
    try {
      await db.matches.update(matchId, { homeTeamConnectionEnabled: enabled })
    } catch (error) {
      // Silently handle error
    }
  }, [matchId])

  const handleAwayTeamConnectionToggle = useCallback(async (enabled) => {
    if (!matchId) return
    try {
      await db.matches.update(matchId, { awayTeamConnectionEnabled: enabled })
    } catch (error) {
      // Silently handle error
    }
  }, [matchId])

  const handleEditPin = useCallback((type = 'referee') => {
    let currentPin = ''
    if (type === 'referee') {
      currentPin = data?.match?.refereePin || ''
    } else if (type === 'teamA') {
      currentPin = data?.match?.homeTeamPin || ''
    } else if (type === 'teamB') {
      currentPin = data?.match?.awayTeamPin || ''
    }
    setNewPin(currentPin)
    setPinError('')
    setEditPinType(type)
    setEditPinModal(true)
  }, [data?.match?.refereePin, data?.match?.homeTeamPin, data?.match?.awayTeamPin])

  const handleSavePin = useCallback(async () => {
    if (!matchId) return
    
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
      let updateField = {}
      if (editPinType === 'referee') {
        updateField = { refereePin: newPin }
      } else if (editPinType === 'teamA') {
        updateField = { homeTeamPin: newPin }
      } else if (editPinType === 'teamB') {
        updateField = { awayTeamPin: newPin }
      }
      await db.matches.update(matchId, updateField)
      setEditPinModal(false)
      setPinError('')
      setEditPinType(null)
    } catch (error) {
      setPinError('Failed to save PIN')
    }
  }, [matchId, newPin, editPinType])

  const confirmCourtSwitch = useCallback(async () => {
    if (!courtSwitchModal) return
    
    // Mark that courts have been switched for set 5
    await db.matches.update(matchId, { set5CourtSwitched: true })
    
    // Close the modal
    setCourtSwitchModal(null)
    
    // Note: Teams will automatically switch on next point based on leftIsHome logic
  }, [courtSwitchModal, matchId])

  const cancelCourtSwitch = useCallback(async () => {
    if (!courtSwitchModal || !data?.events) return
    
    // Undo the last point that caused the 8-point threshold
    // Find the last event by sequence number
    const sortedEvents = [...data.events].sort((a, b) => {
      const aSeq = a.seq || 0
      const bSeq = b.seq || 0
      if (aSeq !== 0 || bSeq !== 0) {
        return bSeq - aSeq // Descending
      }
      const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
      const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
      return bTime - aTime
    })
    
    const lastEvent = sortedEvents[0]
    if (lastEvent) {
      // Delete the last event (point or sanction)
      await db.events.delete(lastEvent.id)
      
      // Update set points
      const newHomePoints = courtSwitchModal.teamThatScored === 'home' 
        ? courtSwitchModal.homePoints - 1 
        : courtSwitchModal.homePoints
      const newAwayPoints = courtSwitchModal.teamThatScored === 'away' 
        ? courtSwitchModal.awayPoints - 1 
        : courtSwitchModal.awayPoints
      
      await db.sets.update(courtSwitchModal.set.id, {
        homePoints: newHomePoints,
        awayPoints: newAwayPoints
      })
    }
    
    setCourtSwitchModal(null)
  }, [courtSwitchModal, data?.events])

  if (!data?.set) {
    return <p>Loading…</p>
  }

  const teamALabel = leftTeam.isTeamA ? 'A' : 'B'
  const teamBLabel = rightTeam.isTeamA ? 'A' : 'B'
  const teamAShortName = leftIsHome 
    ? (data?.match?.homeShortName || leftTeam.name?.substring(0, 3).toUpperCase() || 'A')
    : (data?.match?.awayShortName || leftTeam.name?.substring(0, 3).toUpperCase() || 'A')
  const teamBShortName = leftIsHome 
    ? (data?.match?.awayShortName || rightTeam.name?.substring(0, 3).toUpperCase() || 'B')
    : (data?.match?.homeShortName || rightTeam.name?.substring(0, 3).toUpperCase() || 'B')

  // Help content function
  const getHelpContent = (topicId) => {
    switch (topicId) {
      case 'recording-points':
        return (
          <div>
            <h3 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '16px' }}>Recording Points</h3>
            <div style={{ background: 'rgba(255, 255, 255, 0.05)', padding: '20px', borderRadius: '8px' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>What happens when you record a point:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>The score updates automatically for the team that scored</li>
                <li>The point is logged in the event history</li>
                <li>The serving team indicator updates</li>
                <li>If a team reaches 25 points (or 15 in set 5) with a 2-point lead, you'll be prompted to end the set</li>
                <li>All actions are saved automatically to the database</li>
              </ul>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginTop: '20px', marginBottom: '12px' }}>Keyboard Shortcuts:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li><strong>Space</strong>: Award point to home team</li>
                <li><strong>Enter</strong>: Award point to away team</li>
              </ul>
            </div>
          </div>
        )
      
      case 'timeouts':
        return (
          <div>
            <h3 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '16px' }}>Timeouts</h3>
            <div style={{ background: 'rgba(255, 255, 255, 0.05)', padding: '20px', borderRadius: '8px' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>What happens when you request a timeout:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>A 30-second countdown timer starts automatically</li>
                <li>The timeout is recorded in the event log</li>
                <li>Each team is limited to 2 timeouts per set</li>
                <li>The timeout countdown is displayed on screen</li>
                <li>You can see timeout history in the timeout details panel</li>
              </ul>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginTop: '20px', marginBottom: '12px' }}>Important Notes:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>Timeouts cannot be requested if the team has already used both timeouts in the set</li>
                <li>The timer continues even if you navigate away from the scoreboard</li>
                <li>Timeouts are automatically saved to the database</li>
              </ul>
            </div>
          </div>
        )
      
      case 'substitutions':
        return (
          <div>
            <h3 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '16px' }}>Substitutions</h3>
            <div style={{ background: 'rgba(255, 255, 255, 0.05)', padding: '20px', borderRadius: '8px' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>What happens when you make a substitution:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>Click on the player position on the court to open substitution options</li>
                <li>Select the player going out and the player coming in</li>
                <li>The substitution is recorded with the current score</li>
                <li>The lineup updates immediately on the scoreboard</li>
                <li>Substitution history is tracked and can be viewed</li>
                <li>Each team has unlimited substitutions per set</li>
              </ul>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginTop: '20px', marginBottom: '12px' }}>Special Cases:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li><strong>Injury Substitution</strong>: Mark as injury if a player is injured</li>
                <li><strong>Exceptional Substitution</strong>: For expelled/disqualified players</li>
                <li><strong>Libero Substitution</strong>: Special rules apply for libero exchanges</li>
              </ul>
            </div>
          </div>
        )
      
      case 'libero':
        return (
          <div>
            <h3 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '16px' }}>Libero Substitutions</h3>
            <div style={{ background: 'rgba(255, 255, 255, 0.05)', padding: '20px', borderRadius: '8px' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>What happens with libero substitutions:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>Liberos can only replace back-row players</li>
                <li>Libero exchanges don't count as regular substitutions</li>
                <li>Each team can have up to 2 liberos (Libero 1 and Libero 2)</li>
                <li>Libero exchanges are unlimited but must follow rotation rules</li>
                <li>The libero must exit before the next serve</li>
              </ul>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginTop: '20px', marginBottom: '12px' }}>Libero Rules:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>Libero cannot serve (except in specific situations)</li>
                <li>Libero cannot attack from front row</li>
                <li>Libero redesignation is possible if a libero becomes unable to play</li>
                <li>All libero actions are automatically tracked</li>
              </ul>
            </div>
          </div>
        )
      
      case 'sanctions':
        return (
          <div>
            <h3 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '16px' }}>Sanctions</h3>
            <div style={{ background: 'rgba(255, 255, 255, 0.05)', padding: '20px', borderRadius: '8px' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>What happens when you record a sanction:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li><strong>Warning (Yellow Card)</strong>: First offense, no point penalty</li>
                <li><strong>Penalty (Red Card)</strong>: Second offense, point awarded to opponent</li>
                <li><strong>Expulsion</strong>: Player must leave the set, can return next set</li>
                <li><strong>Disqualification</strong>: Player must leave the match entirely</li>
                <li>Sanctions are recorded with the score at the time of the sanction</li>
                <li>All sanctions appear in the sanctions table on the match end screen</li>
              </ul>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginTop: '20px', marginBottom: '12px' }}>Who Can Receive Sanctions:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>Players on the court</li>
                <li>Bench players</li>
                <li>Coaches and bench officials</li>
                <li>Team (delay warnings/penalties)</li>
              </ul>
            </div>
          </div>
        )
      
      case 'ending-set':
        return (
          <div>
            <h3 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '16px' }}>Ending a Set</h3>
            <div style={{ background: 'rgba(255, 255, 255, 0.05)', padding: '20px', borderRadius: '8px' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>What happens when you end a set:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>You'll be prompted to confirm the set end time</li>
                <li>The set is marked as finished in the database</li>
                <li>Set statistics are calculated (timeouts, substitutions, duration)</li>
                <li>If it's set 4, you'll be asked to choose sides and first serve for set 5</li>
                <li>If it's set 5, the match ends automatically</li>
                <li>If a team wins 3 sets, the match ends and you go to the Match End screen</li>
                <li>Otherwise, the next set begins automatically</li>
              </ul>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginTop: '20px', marginBottom: '12px' }}>Set End Conditions:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li><strong>Sets 1-4</strong>: First team to 25 points with 2-point lead</li>
                <li><strong>Set 5</strong>: First team to 15 points with 2-point lead</li>
                <li>No cap - sets continue until a team wins by 2 points</li>
              </ul>
            </div>
          </div>
        )
      
      case 'match-end':
        return (
          <div>
            <h3 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '16px' }}>Match End</h3>
            <div style={{ background: 'rgba(255, 255, 255, 0.05)', padding: '20px', borderRadius: '8px' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>What happens when the match ends:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>The match status is automatically set to "final"</li>
                <li>You're taken to the Match End screen</li>
                <li>All match data is preserved (sets, events, players, teams)</li>
                <li>For official matches, the match is queued for sync to Supabase</li>
                <li>The session lock is released</li>
                <li>You can review results, sanctions, and match statistics</li>
              </ul>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginTop: '20px', marginBottom: '12px' }}>Match End Screen:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>View final score and set-by-set breakdown</li>
                <li>Review all sanctions issued</li>
                <li>Collect signatures from captains and officials</li>
                <li>Approve and export match data (PDF, JPG, JSON)</li>
                <li>Return to home screen when done</li>
              </ul>
            </div>
          </div>
        )
      
      case 'undo':
        return (
          <div>
            <h3 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '16px' }}>Undo Actions</h3>
            <div style={{ background: 'rgba(255, 255, 255, 0.05)', padding: '20px', borderRadius: '8px' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>What happens when you undo an action:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>The last action is reversed (point, substitution, timeout, etc.)</li>
                <li>The score or state returns to what it was before</li>
                <li>The undo event is logged in the action history</li>
                <li>You can undo multiple actions in sequence</li>
                <li>Undo works for most actions except set/match end</li>
              </ul>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginTop: '20px', marginBottom: '12px' }}>How to Undo:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>Click the <strong>Undo</strong> button in the rally controls</li>
                <li>Or use the keyboard shortcut (if available)</li>
                <li>Confirm the undo action when prompted</li>
                <li>Check the action log to see undo history</li>
              </ul>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginTop: '20px', marginBottom: '12px' }}>Limitations:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>Cannot undo set end or match end</li>
                <li>Cannot undo actions from previous sets</li>
                <li>Undo only affects the current set</li>
              </ul>
            </div>
          </div>
        )
      
      case 'lineup':
        return (
          <div>
            <h3 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '16px' }}>Setting Lineup</h3>
            <div style={{ background: 'rgba(255, 255, 255, 0.05)', padding: '20px', borderRadius: '8px' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>What happens when you set the lineup:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>You assign 6 players to court positions (I, II, III, IV, V, VI)</li>
                <li>The lineup determines the serving order</li>
                <li>Players rotate positions when they win the serve back</li>
                <li>The lineup is saved and used throughout the set</li>
                <li>You can set lineup manually or use automatic lineup</li>
              </ul>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginTop: '20px', marginBottom: '12px' }}>Lineup Rules:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>Must have exactly 6 players on court</li>
                <li>Liberos cannot be in the initial lineup</li>
                <li>Lineup must be set before the set starts</li>
                <li>Lineup can be adjusted manually if needed</li>
              </ul>
            </div>
          </div>
        )
      
      case 'set-5':
        return (
          <div>
            <h3 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '16px' }}>Set 5 (Tie-break)</h3>
            <div style={{ background: 'rgba(255, 255, 255, 0.05)', padding: '20px', borderRadius: '8px' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>What happens in Set 5:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>First team to 15 points wins (instead of 25)</li>
                <li>Must win by 2 points (no cap)</li>
                <li>Teams switch sides when one team reaches 8 points</li>
                <li>You'll be prompted to choose which team is on which side</li>
                <li>First serve is determined by coin toss result or set 4 outcome</li>
                <li>All other rules remain the same (timeouts, substitutions, etc.)</li>
              </ul>
              <h4 style={{ fontSize: '18px', fontWeight: 600, marginTop: '20px', marginBottom: '12px' }}>Court Switch at 8 Points:</h4>
              <ul style={{ paddingLeft: '20px', lineHeight: '1.8' }}>
                <li>When a team reaches 8 points, the app will prompt for court switch</li>
                <li>You'll confirm which team is now on which side</li>
                <li>The scoreboard updates to reflect the new positions</li>
                <li>Play continues without interruption</li>
              </ul>
            </div>
          </div>
        )
      
      default:
        return <div>Topic not found</div>
    }
  }

  // Show duplicate tab error if scoresheet is already open in another tab
  if (duplicateTabError) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--bg)',
        color: 'var(--text)',
        padding: '20px',
        textAlign: 'center'
      }}>
        <div style={{
          fontSize: '48px',
          marginBottom: '20px'
        }}>⚠️</div>
        <h1 style={{
          fontSize: '24px',
          fontWeight: 600,
          marginBottom: '12px',
          color: '#f59e0b'
        }}>Scoresheet Already Open</h1>
        <p style={{
          fontSize: '16px',
          color: 'rgba(255,255,255,0.7)',
          marginBottom: '24px',
          maxWidth: '400px'
        }}>
          This match scoresheet is already open in another tab or browser window.
          Please close this tab and use the existing one to avoid data conflicts.
        </p>
        <button
          onClick={() => window.close()}
          style={{
            padding: '12px 24px',
            fontSize: '16px',
            fontWeight: 600,
            background: '#3b82f6',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer'
          }}
        >
          Close This Tab
        </button>
      </div>
    )
  }

  return (
    <div className="match-record">
      <ScoreboardToolbar>
        <div className="toolbar-left">
          <button 
            className="secondary" 
            onClick={() => (onOpenSetup ? onOpenSetup() : null)}
            style={{ background: '#22c55e', color: '#000', fontWeight: 600 }}
          >
            Home
          </button>
          </div>
          <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span className="toolbar-clock">{formatTimestamp(now)}</span>
            <div className="toolbar-divider" />
            <button
              className="secondary"
              onClick={async () => {
                try {
                  const match = data?.match
                  if (!match) {
                    alert('No match data available')
                    return
                  }

                  // Gather all match data for the scoresheet
                  const allSets = data?.sets || []
                  const allEvents = data?.events || []

                  const scoresheetData = {
                    match,
                    homeTeam: data?.homeTeam,
                    awayTeam: data?.awayTeam,
                    homePlayers: data?.homePlayers || [],
                    awayPlayers: data?.awayPlayers || [],
                    sets: allSets,
                    events: allEvents,
                    sanctions: [] // TODO: Extract sanctions from events
                  }

                  // Store data in sessionStorage to pass to new window
                  sessionStorage.setItem('scoresheetData', JSON.stringify(scoresheetData))

                  // Open scoresheet in new window
                  const scoresheetWindow = window.open('/scoresheet.html', '_blank', 'width=1200,height=900')

                  if (!scoresheetWindow) {
                    alert('Please allow popups to view the scoresheet')
                    return
                  }

                  // Set up error listener for scoresheet window
                  const errorListener = (event) => {
                    // Only accept messages from the scoresheet window
                    if (event.data && event.data.type === 'SCORESHEET_ERROR') {
                      setScoresheetErrorModal({
                        error: event.data.error || 'Unknown error',
                        details: event.data.details || event.data.stack || ''
                      })
                      window.removeEventListener('message', errorListener)
                    }
                  }

                  window.addEventListener('message', errorListener)

                  // Clean up listener after 30 seconds (scoresheet should load by then)
                  setTimeout(() => {
                    window.removeEventListener('message', errorListener)
                  }, 30000)
                } catch (error) {
                  console.error('Error opening scoresheet:', error)
                  setScoresheetErrorModal({
                    error: 'Failed to open scoresheet',
                    details: error.message || ''
                  })
                }
              }}
              style={{ background: '#22c55e', color: '#000', fontWeight: 600 }}
            >
              📄 Scoresheet
            </button>
          </div>
        <div className="toolbar-actions" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>

          
          <MenuList
            buttonLabel="Menu"
            buttonClassName="secondary"
            buttonStyle={{ background: '#22c55e', color: '#000', fontWeight: 600, width: '160px', textAlign: 'center' }}
            position="right"
            items={[
              {
                key: 'action-log',
                label: 'Show Action Log',
                onClick: () => {
                  setShowLogs(true)
                }
              },
              {
                key: 'sanctions',
                label: 'Show Sanctions and Results',
                onClick: () => {
                  setShowSanctions(true)
                }
              },
              {
                key: 'manual',
                label: 'Manual Changes',
                onClick: () => {
                  setShowManualPanel(true)
                }
              },
              {
                key: 'remarks',
                label: 'Open Remarks Recording',
                onClick: () => {
                  setShowRemarks(true)
                }
              },
              {
                key: 'rosters',
                label: 'Show Rosters',
                onClick: () => {
                  setShowRosters(true)
                }
              },
              {
                key: 'pins',
                label: 'Show PINs',
                onClick: () => {
                  setShowPinsModal(true)
                }
              },
              ...(onOpenMatchSetup ? [{
                key: 'match-setup',
                label: 'Show Match Setup',
                onClick: () => {
                  onOpenMatchSetup()
                }
              }] : []),
              { separator: true },
              {
                key: 'export',
                label: '📥 Download Game Data (JSON)',
                onClick: async () => {
                  try {
                    // Export all database data
                    const allMatches = await db.matches.toArray()
                    const allTeams = await db.teams.toArray()
                    const allPlayers = await db.players.toArray()
                    const allSets = await db.sets.toArray()
                    const allEvents = await db.events.toArray()
                    const allReferees = await db.referees.toArray()
                    const allScorers = await db.scorers.toArray()
                    
                    const exportData = {
                      exportDate: new Date().toISOString(),
                      matchId: matchId,
                      matches: allMatches,
                      teams: allTeams,
                      players: allPlayers,
                      sets: allSets,
                      events: allEvents,
                      referees: allReferees,
                      scorers: allScorers
                    }
                    
                    // Create a blob and download
                    const jsonString = JSON.stringify(exportData, null, 2)
                    const blob = new Blob([jsonString], { type: 'application/json' })
                    const url = URL.createObjectURL(blob)
                    const link = document.createElement('a')
                    link.href = url
                    link.download = `database_export_${matchId}_${new Date().toISOString().split('T')[0]}.json`
                    document.body.appendChild(link)
                    link.click()
                    document.body.removeChild(link)
                    URL.revokeObjectURL(url)
                  } catch (error) {
                    console.error('Error exporting database:', error)
                    alert('Error exporting database data. Please try again.')
                  }
                }
              },
              {
                key: 'options',
                label: '⚙️ Options',
                onClick: () => {
                  setShowOptionsInMenu(true)
                }
              }
            ]}
          />
        </div>
      </ScoreboardToolbar>

      {/* Scoresheet Error Modal */}
      {scoresheetErrorModal && (
        <Modal
          title="Scoresheet Error"
          open={!!scoresheetErrorModal}
          onClose={() => setScoresheetErrorModal(null)}
        >
          <div style={{ padding: '20px' }}>
            <div style={{ 
              color: '#ef4444', 
              fontSize: '16px', 
              fontWeight: 600, 
              marginBottom: '12px' 
            }}>
              {scoresheetErrorModal.error}
            </div>
            {scoresheetErrorModal.details && (
              <div style={{ 
                marginTop: '12px',
                padding: '12px',
                background: '#1e293b',
                borderRadius: '6px',
                fontFamily: 'monospace',
                fontSize: '12px',
                color: '#cbd5e1',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '400px',
                overflow: 'auto'
              }}>
                {scoresheetErrorModal.details}
              </div>
            )}
            <div style={{ marginTop: '20px', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button 
                onClick={() => setScoresheetErrorModal(null)}
                style={{
                  padding: '8px 16px',
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 600
                }}
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Rosters Modal */}
      {showRosters && (
        <Modal
          title="Rosters"
          open={showRosters}
          onClose={() => setShowRosters(false)}
          width={1200}
        >
          {(() => {
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
        </Modal>
      )}

      {/* Team Names Container */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        width: 'auto',
        padding: '12px 16px',
        background: 'rgba(15, 23, 42, 0.4)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
      }}>
        {/* Left Team - 40% */}
        <div style={{
          flex: '1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '8px',
          paddingRight: '12px',
          height: '100%'
        }}>

          <span style={{
            fontSize: '16px',
            fontWeight: 600,
            color: 'var(--text)',
            lineHeight: '1.2'
          }}>
            {leftTeam.name || (leftIsHome ? 'Home' : 'Away')}
          </span>
          <div style={{
            padding: '4px 10px',
            borderRadius: '6px',
            fontSize: '14px',
            fontWeight: 700,
            background: leftTeam.color || '#ef4444',
            color: isBrightColor(leftTeam.color || '#ef4444') ? '#000' : '#fff',
            minWidth: '32px',
            textAlign: 'center',
            lineHeight: '1.2',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            {teamALabel}
          </div>
        </div>

        {/* Set Counter - 20% */}
        <div style={{
          flex: '0 0 20%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: '16px'
        }}>
          <div style={{
            padding: '6px 12px',
            borderRadius: '6px',
            fontSize: '16px',
            fontWeight: 700,
            background: 'rgba(255, 255, 255, 0.1)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            color: 'var(--text)',
            textAlign: 'center',
            lineHeight: '1',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            {setScore.left}
          </div>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '2px'
          }}>
            <span style={{
              fontSize: '20px',
              fontWeight: 600,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              lineHeight: '1'
            }}>
              SET
            </span>
            <span style={{
              fontSize: '20px',
              fontWeight: 700,
              color: 'var(--text)',
              lineHeight: '1'
            }}>
              {data?.set?.index || 1}
            </span>
          </div>
          <div style={{
            padding: '6px 12px',
            borderRadius: '6px',
            fontSize: '16px',
            fontWeight: 700,
            background: 'rgba(255, 255, 255, 0.1)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            color: 'var(--text)',
            textAlign: 'center',
            lineHeight: '1',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            {setScore.right}
          </div>
        </div>

        {/* Right Team - 40% */}
        <div style={{
          flex: '1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: '8px',
          paddingLeft: '12px',
          height: '100%'
        }}>
          
          <div style={{
            padding: '4px 10px',
            borderRadius: '6px',
            fontSize: '14px',
            fontWeight: 700,
            background: rightTeam.color || '#3b82f6',
            color: isBrightColor(rightTeam.color || '#3b82f6') ? '#000' : '#fff',
            minWidth: '32px',
            textAlign: 'center',
            lineHeight: '1.2',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            {teamBLabel}
          </div>
          <span style={{
            fontSize: '16px',
            fontWeight: 600,
            color: 'var(--text)',
            lineHeight: '1.2'
          }}>
            {rightTeam.name || (leftIsHome ? 'Away' : 'Home')}
          </span>

        </div>
      </div>

      {/* Display Mode Suggestion Banner */}
      {showDisplayModeSuggestion && displayModeSuggestion && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
          color: '#fff',
          padding: '12px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '16px',
          zIndex: 1000,
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
        }}>
          <span style={{ fontSize: '20px' }}>
            {displayModeSuggestion === 'tablet' ? '📱' : '📲'}
          </span>
          <span style={{ fontWeight: 600 }}>
            Small screen detected! Enable {displayModeSuggestion} mode for a better experience?
          </span>
          <button
            onClick={() => enterDisplayMode(displayModeSuggestion)}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 600,
              background: '#fff',
              color: '#3b82f6',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            Enable {displayModeSuggestion} mode
          </button>
          <button
            onClick={() => {
              setShowDisplayModeSuggestion(false)
              sessionStorage.setItem('displayModeSuggestionDismissed', 'true')
            }}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 600,
              background: 'transparent',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.5)',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            Not now
          </button>
        </div>
      )}

      {/* Smartphone Mode Layout */}
      {activeDisplayMode === 'smartphone' ? (() => {
        // Calculate timeout and substitution counts for current set
        const currentLeftTeamKey = leftIsHome ? 'home' : 'away'
        const currentRightTeamKey = leftIsHome ? 'away' : 'home'
        const currentSetIndex = data?.set?.index || 1

        const leftTimeouts = (data?.events || []).filter(e =>
          e.type === 'timeout' && e.setIndex === currentSetIndex && e.payload?.team === currentLeftTeamKey
        ).length

        const rightTimeouts = (data?.events || []).filter(e =>
          e.type === 'timeout' && e.setIndex === currentSetIndex && e.payload?.team === currentRightTeamKey
        ).length

        const leftSubstitutions = (data?.events || []).filter(e =>
          e.type === 'substitution' && e.setIndex === currentSetIndex && e.payload?.team === currentLeftTeamKey
        ).length

        const rightSubstitutions = (data?.events || []).filter(e =>
          e.type === 'substitution' && e.setIndex === currentSetIndex && e.payload?.team === currentRightTeamKey
        ).length

        // Get current lineups for left and right teams
        const leftTeamLineupState = getTeamLineupState(currentLeftTeamKey)
        const rightTeamLineupState = getTeamLineupState(currentRightTeamKey)

        const leftLineup = leftTeamLineupState.currentLineup ?
          Object.entries(leftTeamLineupState.currentLineup).map(([position, number]) => ({ position, number })) :
          []

        const rightLineup = rightTeamLineupState.currentLineup ?
          Object.entries(rightTeamLineupState.currentLineup).map(([position, number]) => ({ position, number })) :
          []

        // Determine who is serving
        const leftServes = data?.set?.servingTeam === currentLeftTeamKey
        const rightServes = data?.set?.servingTeam === currentRightTeamKey

        // Get bench players for left and right teams
        const leftBenchPlayers = leftTeamBench.benchPlayers || []
        const rightBenchPlayers = rightTeamBench.benchPlayers || []

        return (
        <div className="smartphone-layout" style={{
          display: 'flex',
          flexDirection: 'column',
          height: 'calc(100vh - 40px)',
          width: '100%',
          background: 'var(--bg)',
          overflow: 'hidden',
          position: 'relative'
        }}>
          {/* Fixed Header: Menu and Scoresheet buttons */}
          <div style={{
            position: 'sticky',
            top: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            background: 'rgba(15, 23, 42, 0.95)',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
            zIndex: 10,
            flexShrink: 0
          }}>
            <button
              onClick={() => setMenuModal(true)}
              style={{
                padding: '8px 12px',
                fontSize: '13px',
                fontWeight: 600,
                background: '#22c55e',
                color: '#000',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              Menu
            </button>

            {/* Set Counter - Center */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              fontSize: '16px',
              fontWeight: 700
            }}>
              <span style={{ color: leftTeam?.color || '#ef4444' }}>
                {setScore.left}
              </span>
              <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>SETS</span>
              <span style={{ color: rightTeam?.color || '#3b82f6' }}>
                {setScore.right}
              </span>
            </div>

            <button
              onClick={async () => {
                const match = data?.match
                if (!match) return
                const scoresheetData = {
                  match,
                  homeTeam: data?.homeTeam,
                  awayTeam: data?.awayTeam,
                  homePlayers: data?.homePlayers || [],
                  awayPlayers: data?.awayPlayers || [],
                  sets: data?.sets || [],
                  events: data?.events || [],
                  sanctions: []
                }
                sessionStorage.setItem('scoresheetData', JSON.stringify(scoresheetData))
                window.open('/scoresheet.html', '_blank', 'width=1200,height=900')
              }}
              style={{
                padding: '8px 12px',
                fontSize: '13px',
                fontWeight: 600,
                background: '#22c55e',
                color: '#000',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              Sheet
            </button>
          </div>

          {/* Main 3-Column Layout */}
          <div style={{
            display: 'flex',
            flex: 1,
            minHeight: 0,
            overflow: 'hidden'
          }}>
            {/* Left Team Column */}
            <div style={{
              flex: '0 0 30%',
              maxWidth: '30%',
              display: 'flex',
              flexDirection: 'column',
              padding: '8px',
              background: 'rgba(15, 23, 42, 0.4)',
              borderRight: '1px solid rgba(255,255,255,0.1)',
              overflow: 'auto'
            }}>
              <div style={{
                background: leftTeam?.color || '#ef4444',
                color: isBrightColor(leftTeam?.color || '#ef4444') ? '#000' : '#fff',
                padding: '8px',
                borderRadius: '6px',
                textAlign: 'center',
                fontWeight: 700,
                fontSize: '14px',
                marginBottom: '8px'
              }}>
                {leftTeam?.shortName || leftTeam?.name || 'Team A'}
              </div>

              {/* TO/SUB Counter */}
              <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                <div style={{
                  flex: 1,
                  background: 'rgba(255,255,255,0.1)',
                  padding: '6px',
                  borderRadius: '4px',
                  textAlign: 'center',
                  fontSize: '11px'
                }}>
                  <div style={{ fontWeight: 600 }}>TO</div>
                  <div style={{ fontSize: '16px', fontWeight: 700 }}>{leftTimeouts}</div>
                </div>
                <div style={{
                  flex: 1,
                  background: 'rgba(255,255,255,0.1)',
                  padding: '6px',
                  borderRadius: '4px',
                  textAlign: 'center',
                  fontSize: '11px'
                }}>
                  <div style={{ fontWeight: 600 }}>SUB</div>
                  <div style={{ fontSize: '16px', fontWeight: 700 }}>{leftSubstitutions}</div>
                </div>
              </div>

              {/* Team Sanctions Button */}
              <button
                onClick={() => setLeftTeamSanctionsExpanded(!leftTeamSanctionsExpanded)}
                style={{
                  width: '100%',
                  padding: '8px',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: leftTeamSanctionsExpanded ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255,255,255,0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  marginBottom: '4px'
                }}
              >
                Team Sanctions {leftTeamSanctionsExpanded ? '▲' : '▼'}
              </button>

              {leftTeamSanctionsExpanded && (
                <div style={{
                  background: 'rgba(15, 23, 42, 0.6)',
                  borderRadius: '6px',
                  padding: '8px',
                  marginBottom: '8px',
                  fontSize: '11px'
                }}>
                  <button
                    onClick={() => handleTeamSanction(leftIsHome ? 'home' : 'away', 'improper_request')}
                    style={{
                      width: '100%',
                      padding: '6px',
                      marginBottom: '4px',
                      fontSize: '11px',
                      background: 'rgba(255,255,255,0.1)',
                      color: 'var(--text)',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    Improper Request
                  </button>
                  <button
                    onClick={() => handleTeamSanction(leftIsHome ? 'home' : 'away', 'delay_warning')}
                    style={{
                      width: '100%',
                      padding: '6px',
                      marginBottom: '4px',
                      fontSize: '11px',
                      background: 'rgba(234, 179, 8, 0.3)',
                      color: '#fbbf24',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    Delay Warning
                  </button>
                  <button
                    onClick={() => handleTeamSanction(leftIsHome ? 'home' : 'away', 'delay_penalty')}
                    style={{
                      width: '100%',
                      padding: '6px',
                      fontSize: '11px',
                      background: 'rgba(239, 68, 68, 0.3)',
                      color: '#ef4444',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    Delay Penalty
                  </button>
                </div>
              )}

              {/* Show Bench Button */}
              <button
                onClick={() => setLeftTeamBenchExpanded(!leftTeamBenchExpanded)}
                style={{
                  width: '100%',
                  padding: '8px',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: leftTeamBenchExpanded ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255,255,255,0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                Show Bench {leftTeamBenchExpanded ? '▲' : '▼'}
              </button>

              {leftTeamBenchExpanded && (
                <div style={{
                  background: 'rgba(15, 23, 42, 0.6)',
                  borderRadius: '6px',
                  padding: '8px',
                  marginTop: '4px',
                  fontSize: '11px'
                }}>
                  <div style={{ fontWeight: 600, marginBottom: '4px' }}>Bench Players:</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {leftBenchPlayers.filter(p => p.role !== 'libero').map(p => (
                      <span
                        key={p.id}
                        onClick={() => {
                          // Open bench player action menu
                          setBenchPlayerActionMenu({
                            team: leftIsHome ? 'home' : 'away',
                            playerNumber: p.number,
                            element: null,
                            x: window.innerWidth / 2,
                            y: window.innerHeight / 2
                          })
                        }}
                        style={{
                          padding: '4px 8px',
                          background: 'rgba(255,255,255,0.1)',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        #{p.number}
                      </span>
                    ))}
                  </div>
                  {leftBenchPlayers.filter(p => p.role === 'libero').length > 0 && (
                    <>
                      <div style={{ fontWeight: 600, marginTop: '8px', marginBottom: '4px', color: '#22c55e' }}>Libero:</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {leftBenchPlayers.filter(p => p.role === 'libero').map(p => (
                          <span
                            key={p.id}
                            style={{
                              padding: '4px 8px',
                              background: 'rgba(34, 197, 94, 0.3)',
                              borderRadius: '4px',
                              color: '#22c55e'
                            }}
                          >
                            #{p.number}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Center Column */}
            <div style={{
              flex: '0 0 40%',
              maxWidth: '40%',
              display: 'flex',
              flexDirection: 'column',
              padding: '8px',
              overflow: 'auto',
              alignItems: 'center'
            }}>
              {/* Score Counter */}
              <div style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                gap: '24px',
                marginBottom: '12px',
                width: '100%'
              }}>
                <span style={{
                  fontSize: '48px',
                  fontWeight: 700,
                  color: leftTeam?.color || '#ef4444'
                }}>
                  {leftIsHome ? (data?.set?.homePoints || 0) : (data?.set?.awayPoints || 0)}
                </span>
                <span style={{ fontSize: '24px', color: 'rgba(255,255,255,0.4)' }}>-</span>
                <span style={{
                  fontSize: '48px',
                  fontWeight: 700,
                  color: rightTeam?.color || '#3b82f6'
                }}>
                  {leftIsHome ? (data?.set?.awayPoints || 0) : (data?.set?.homePoints || 0)}
                </span>
              </div>

              {/* Mini Court Position Tables */}
              <div style={{
                display: 'flex',
                gap: '8px',
                marginBottom: '12px',
                justifyContent: 'center',
                width: '100%',
                flexWrap: 'wrap'
              }}>
                {/* Left Team Positions */}
                <div style={{
                  background: 'rgba(15, 23, 42, 0.6)',
                  borderRadius: '6px',
                  padding: '8px',
                  border: `2px solid ${leftTeam?.color || '#ef4444'}`
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2px', fontSize: '11px' }}>
                    {['IV', 'III', 'II'].map(pos => {
                      const player = leftLineup?.find(p => p.position === pos)
                      const isServing = leftServes && pos === 'I'
                      return (
                        <div key={pos} style={{
                          padding: '4px',
                          background: isServing ? 'rgba(234, 179, 8, 0.3)' : 'rgba(255,255,255,0.1)',
                          borderRadius: '2px',
                          textAlign: 'center'
                        }}>
                          <div style={{ fontSize: '8px', color: 'rgba(255,255,255,0.5)' }}>{pos}</div>
                          <div style={{ fontWeight: 600 }}>{player?.number || '-'}</div>
                        </div>
                      )
                    })}
                    {['V', 'VI', 'I'].map(pos => {
                      const player = leftLineup?.find(p => p.position === pos)
                      const isServing = leftServes && pos === 'I'
                      return (
                        <div key={pos} style={{
                          padding: '4px',
                          background: isServing ? 'rgba(234, 179, 8, 0.3)' : 'rgba(255,255,255,0.1)',
                          borderRadius: '2px',
                          textAlign: 'center'
                        }}>
                          <div style={{ fontSize: '8px', color: 'rgba(255,255,255,0.5)' }}>{pos}</div>
                          <div style={{ fontWeight: 600 }}>{player?.number || '-'}</div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Right Team Positions */}
                <div style={{
                  background: 'rgba(15, 23, 42, 0.6)',
                  borderRadius: '6px',
                  padding: '8px',
                  border: `2px solid ${rightTeam?.color || '#3b82f6'}`
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2px', fontSize: '11px' }}>
                    {['II', 'III', 'IV'].map(pos => {
                      const player = rightLineup?.find(p => p.position === pos)
                      const isServing = rightServes && pos === 'I'
                      return (
                        <div key={pos} style={{
                          padding: '4px',
                          background: isServing ? 'rgba(234, 179, 8, 0.3)' : 'rgba(255,255,255,0.1)',
                          borderRadius: '2px',
                          textAlign: 'center'
                        }}>
                          <div style={{ fontSize: '8px', color: 'rgba(255,255,255,0.5)' }}>{pos}</div>
                          <div style={{ fontWeight: 600 }}>{player?.number || '-'}</div>
                        </div>
                      )
                    })}
                    {['I', 'VI', 'V'].map(pos => {
                      const player = rightLineup?.find(p => p.position === pos)
                      const isServing = rightServes && pos === 'I'
                      return (
                        <div key={pos} style={{
                          padding: '4px',
                          background: isServing ? 'rgba(234, 179, 8, 0.3)' : 'rgba(255,255,255,0.1)',
                          borderRadius: '2px',
                          textAlign: 'center'
                        }}>
                          <div style={{ fontSize: '8px', color: 'rgba(255,255,255,0.5)' }}>{pos}</div>
                          <div style={{ fontWeight: 600 }}>{player?.number || '-'}</div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

              {/* Rally Controls */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                marginTop: 'auto'
              }}>
                {timeoutModal && timeoutModal.started ? (
                  <>
                    <div style={{
                      fontSize: '32px',
                      fontWeight: 700,
                      color: 'var(--accent)',
                      textAlign: 'center',
                      fontFamily: 'monospace'
                    }}>
                      {formatCountdown(timeoutModal.countdown)}
                    </div>
                    <button onClick={stopTimeout} style={{
                      padding: '12px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: '#ef4444',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: 'pointer'
                    }}>
                      Stop Timeout
                    </button>
                  </>
                ) : betweenSetsCountdown ? (
                  <>
                    <div style={{
                      fontSize: '32px',
                      fontWeight: 700,
                      color: betweenSetsCountdown.countdown <= 0 ? '#ef4444' : 'var(--accent)',
                      textAlign: 'center',
                      fontFamily: 'monospace'
                    }}>
                      {betweenSetsCountdown.countdown <= 0 ? "0''" : formatCountdown(betweenSetsCountdown.countdown)}
                    </div>
                    <button onClick={endSetInterval} style={{
                      padding: '12px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: 'var(--accent)',
                      color: '#000',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: 'pointer'
                    }}>
                      End Set Interval
                    </button>
                  </>
                ) : rallyStatus === 'idle' ? (
                  <button
                    onClick={handleStartRally}
                    disabled={isFirstRally && (!leftTeamLineupSet || !rightTeamLineupSet)}
                    style={{
                      padding: '16px',
                      fontSize: '16px',
                      fontWeight: 700,
                      background: 'var(--accent)',
                      color: '#000',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      opacity: (isFirstRally && (!leftTeamLineupSet || !rightTeamLineupSet)) ? 0.5 : 1
                    }}
                  >
                    {isFirstRally ? 'Start Set' : 'Start Rally'}
                  </button>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        onClick={() => handlePoint(leftIsHome ? 'home' : 'away')}
                        style={{
                          flex: 1,
                          padding: '16px',
                          fontSize: '14px',
                          fontWeight: 700,
                          background: leftTeam?.color || '#ef4444',
                          color: isBrightColor(leftTeam?.color || '#ef4444') ? '#000' : '#fff',
                          border: 'none',
                          borderRadius: '8px',
                          cursor: 'pointer'
                        }}
                      >
                        Point {leftTeam?.shortName || 'L'}
                      </button>
                      <button
                        onClick={() => handlePoint(leftIsHome ? 'away' : 'home')}
                        style={{
                          flex: 1,
                          padding: '16px',
                          fontSize: '14px',
                          fontWeight: 700,
                          background: rightTeam?.color || '#3b82f6',
                          color: isBrightColor(rightTeam?.color || '#3b82f6') ? '#000' : '#fff',
                          border: 'none',
                          borderRadius: '8px',
                          cursor: 'pointer'
                        }}
                      >
                        Point {rightTeam?.shortName || 'R'}
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        onClick={() => handleTimeout(leftIsHome ? 'home' : 'away')}
                        disabled={leftTimeouts >= 2}
                        style={{
                          flex: 1,
                          padding: '10px',
                          fontSize: '12px',
                          fontWeight: 600,
                          background: 'rgba(255,255,255,0.1)',
                          color: 'var(--text)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '6px',
                          cursor: leftTimeouts >= 2 ? 'not-allowed' : 'pointer',
                          opacity: leftTimeouts >= 2 ? 0.5 : 1
                        }}
                      >
                        TO Left
                      </button>
                      <button
                        onClick={handleUndo}
                        style={{
                          padding: '10px',
                          fontSize: '12px',
                          fontWeight: 600,
                          background: 'rgba(239, 68, 68, 0.2)',
                          color: '#ef4444',
                          border: '1px solid rgba(239, 68, 68, 0.3)',
                          borderRadius: '6px',
                          cursor: 'pointer'
                        }}
                      >
                        Undo
                      </button>
                      <button
                        onClick={() => handleTimeout(leftIsHome ? 'away' : 'home')}
                        disabled={rightTimeouts >= 2}
                        style={{
                          flex: 1,
                          padding: '10px',
                          fontSize: '12px',
                          fontWeight: 600,
                          background: 'rgba(255,255,255,0.1)',
                          color: 'var(--text)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '6px',
                          cursor: rightTimeouts >= 2 ? 'not-allowed' : 'pointer',
                          opacity: rightTimeouts >= 2 ? 0.5 : 1
                        }}
                      >
                        TO Right
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Right Team Column */}
            <div style={{
              flex: '0 0 30%',
              maxWidth: '30%',
              display: 'flex',
              flexDirection: 'column',
              padding: '8px',
              background: 'rgba(15, 23, 42, 0.4)',
              borderLeft: '1px solid rgba(255,255,255,0.1)',
              overflow: 'auto'
            }}>
              <div style={{
                background: rightTeam?.color || '#3b82f6',
                color: isBrightColor(rightTeam?.color || '#3b82f6') ? '#000' : '#fff',
                padding: '8px',
                borderRadius: '6px',
                textAlign: 'center',
                fontWeight: 700,
                fontSize: '14px',
                marginBottom: '8px'
              }}>
                {rightTeam?.shortName || rightTeam?.name || 'Team B'}
              </div>

              {/* TO/SUB Counter */}
              <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                <div style={{
                  flex: 1,
                  background: 'rgba(255,255,255,0.1)',
                  padding: '6px',
                  borderRadius: '4px',
                  textAlign: 'center',
                  fontSize: '11px'
                }}>
                  <div style={{ fontWeight: 600 }}>TO</div>
                  <div style={{ fontSize: '16px', fontWeight: 700 }}>{rightTimeouts}</div>
                </div>
                <div style={{
                  flex: 1,
                  background: 'rgba(255,255,255,0.1)',
                  padding: '6px',
                  borderRadius: '4px',
                  textAlign: 'center',
                  fontSize: '11px'
                }}>
                  <div style={{ fontWeight: 600 }}>SUB</div>
                  <div style={{ fontSize: '16px', fontWeight: 700 }}>{rightSubstitutions}</div>
                </div>
              </div>

              {/* Team Sanctions Button */}
              <button
                onClick={() => setRightTeamSanctionsExpanded(!rightTeamSanctionsExpanded)}
                style={{
                  width: '100%',
                  padding: '8px',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: rightTeamSanctionsExpanded ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255,255,255,0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  marginBottom: '4px'
                }}
              >
                Team Sanctions {rightTeamSanctionsExpanded ? '▲' : '▼'}
              </button>

              {rightTeamSanctionsExpanded && (
                <div style={{
                  background: 'rgba(15, 23, 42, 0.6)',
                  borderRadius: '6px',
                  padding: '8px',
                  marginBottom: '8px',
                  fontSize: '11px'
                }}>
                  <button
                    onClick={() => handleTeamSanction(leftIsHome ? 'away' : 'home', 'improper_request')}
                    style={{
                      width: '100%',
                      padding: '6px',
                      marginBottom: '4px',
                      fontSize: '11px',
                      background: 'rgba(255,255,255,0.1)',
                      color: 'var(--text)',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    Improper Request
                  </button>
                  <button
                    onClick={() => handleTeamSanction(leftIsHome ? 'away' : 'home', 'delay_warning')}
                    style={{
                      width: '100%',
                      padding: '6px',
                      marginBottom: '4px',
                      fontSize: '11px',
                      background: 'rgba(234, 179, 8, 0.3)',
                      color: '#fbbf24',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    Delay Warning
                  </button>
                  <button
                    onClick={() => handleTeamSanction(leftIsHome ? 'away' : 'home', 'delay_penalty')}
                    style={{
                      width: '100%',
                      padding: '6px',
                      fontSize: '11px',
                      background: 'rgba(239, 68, 68, 0.3)',
                      color: '#ef4444',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    Delay Penalty
                  </button>
                </div>
              )}

              {/* Show Bench Button */}
              <button
                onClick={() => setRightTeamBenchExpanded(!rightTeamBenchExpanded)}
                style={{
                  width: '100%',
                  padding: '8px',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: rightTeamBenchExpanded ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255,255,255,0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                Show Bench {rightTeamBenchExpanded ? '▲' : '▼'}
              </button>

              {rightTeamBenchExpanded && (
                <div style={{
                  background: 'rgba(15, 23, 42, 0.6)',
                  borderRadius: '6px',
                  padding: '8px',
                  marginTop: '4px',
                  fontSize: '11px'
                }}>
                  <div style={{ fontWeight: 600, marginBottom: '4px' }}>Bench Players:</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {rightBenchPlayers.filter(p => p.role !== 'libero').map(p => (
                      <span
                        key={p.id}
                        onClick={() => {
                          setBenchPlayerActionMenu({
                            team: leftIsHome ? 'away' : 'home',
                            playerNumber: p.number,
                            element: null,
                            x: window.innerWidth / 2,
                            y: window.innerHeight / 2
                          })
                        }}
                        style={{
                          padding: '4px 8px',
                          background: 'rgba(255,255,255,0.1)',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        #{p.number}
                      </span>
                    ))}
                  </div>
                  {rightBenchPlayers.filter(p => p.role === 'libero').length > 0 && (
                    <>
                      <div style={{ fontWeight: 600, marginTop: '8px', marginBottom: '4px', color: '#22c55e' }}>Libero:</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {rightBenchPlayers.filter(p => p.role === 'libero').map(p => (
                          <span
                            key={p.id}
                            style={{
                              padding: '4px 8px',
                              background: 'rgba(34, 197, 94, 0.3)',
                              borderRadius: '4px',
                              color: '#22c55e'
                            }}
                          >
                            #{p.number}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        )
      })() : (
      <div className="match-content" style={activeDisplayMode === 'tablet' ? { transform: 'scale(0.85)', transformOrigin: 'top center', height: '118vh' } : {}}>
        <ScoreboardTeamColumn side="left">
          <div className="team-info">
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                background: leftTeam.color || '#ef4444',
                color: isBrightColor(leftTeam.color || '#ef4444') ? '#000' : '#fff',
                borderRadius: '6px',
                fontWeight: 600,
                fontSize: '14px',
                marginBottom: '8px'
              }}
            >
              <span>{teamALabel}</span>
              <span>-</span>
              <span>{teamAShortName}</span>
             
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <div 
              onClick={() => {
                const timeouts = getTimeoutDetails('left')
                if (timeouts.length > 0) {
                  setToSubDetailsModal({ type: 'timeout', side: 'left' })
                }
              }}
              style={{ 
                flex: 1, 
                background: 'rgba(255, 255, 255, 0.05)', 
                borderRadius: '8px', 
                padding: '12px',
                textAlign: 'center',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                cursor: getTimeoutDetails('left').length > 0 ? 'pointer' : 'default'
              }}
            >
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>TO</div>
              <div style={{ 
                fontSize: '24px', 
                fontWeight: 700,
                color: getTimeoutsUsed('left') >= 2 ? '#ef4444' : 'inherit'
              }}>{getTimeoutsUsed('left')}</div>
            </div>
            <div 
              onClick={() => {
                const subs = getSubstitutionDetails('left')
                if (subs.length > 0) {
                  setToSubDetailsModal({ type: 'substitution', side: 'left' })
                }
              }}
              style={{ 
                flex: 1, 
                background: 'rgba(255, 255, 255, 0.05)', 
                borderRadius: '8px', 
                padding: '12px',
                textAlign: 'center',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                cursor: getSubstitutionDetails('left').length > 0 ? 'pointer' : 'default'
              }}
            >
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
            disabled={getTimeoutsUsed('left') >= 2 || rallyStatus === 'in_play' || isRallyReplayed}
            style={{ width: '100%', marginBottom: '8px' }}
          >
            Time-out
          </button>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', width: '100%' }}>
            <button 
              onClick={() => handleLiberoOut('left')}
              disabled={rallyStatus === 'in_play' || isRallyReplayed || !getLiberoOnCourt(leftIsHome ? 'home' : 'away') || !hasPointSinceLastLiberoExchange(leftIsHome ? 'home' : 'away')}
              style={{ flex: 1, fontSize: '10px', padding: '8px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              Libero out
            </button>
            <button 
              onClick={() => handleExchangeLibero('left')}
              disabled={(() => {
                const teamKey = leftIsHome ? 'home' : 'away'
                const teamPlayers = leftIsHome ? data?.homePlayers : data?.awayPlayers
                const liberos = teamPlayers?.filter(p => p.libero && p.libero !== '') || []
                const liberoOnCourt = getLiberoOnCourt(teamKey)
                
                // Check if libero on court is unable
                const liberoOnCourtUnable = liberoOnCourt && isLiberoUnable(teamKey, liberoOnCourt.liberoNumber)
                
                // Check if the other libero is unable
                const otherLibero = liberos.find(p => 
                  String(p.number) !== String(liberoOnCourt?.liberoNumber) &&
                  (liberoOnCourt?.liberoType === 'libero1' ? p.libero === 'libero2' : p.libero === 'libero1')
                )
                const otherLiberoUnable = otherLibero && isLiberoUnable(teamKey, otherLibero.number)
                
                return rallyStatus === 'in_play' || 
                       isRallyReplayed ||
                       !liberoOnCourt || 
                       !hasPointSinceLastLiberoExchange(teamKey) ||
                       liberos.length < 2 || // Disable if team has less than 2 liberos
                       liberoOnCourtUnable || // Disable if libero on court is unable
                       otherLiberoUnable // Disable if other libero is unable
              })()}
              style={{ flex: 1, fontSize: '10px', padding: '8px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              Exchange libero
            </button>
          </div>
          
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
          
          {/* Status boxes for team sanctions */}
          <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {data?.match?.sanctions?.improperRequestLeft && (
              <div style={{ 
                padding: '4px 8px', 
                fontSize: '10px', 
                background: 'rgba(156, 163, 175, 0.15)', 
                border: '1px solid rgba(156, 163, 175, 0.3)',
                borderRadius: '4px',
                color: '#d1d5db'
              }}>
                Sanctioned with an improper request
              </div>
            )}
            {data?.match?.sanctions?.delayWarningLeft && (
              <div style={{ 
                padding: '4px 8px', 
                fontSize: '10px', 
                background: 'rgba(234, 179, 8, 0.15)', 
                border: '1px solid rgba(234, 179, 8, 0.3)',
                borderRadius: '4px',
                color: '#facc15'
              }}>
                Sanctioned with a delay warning ⏰
              </div>
            )}
            {teamHasFormalWarning(leftIsHome ? 'home' : 'away') && (
              <div style={{ 
                padding: '4px 8px', 
                fontSize: '10px', 
                background: 'rgba(250, 204, 21, 0.15)', 
                border: '1px solid rgba(250, 204, 21, 0.3)',
                borderRadius: '4px',
                color: '#fde047'
              }}>
                Sanctioned with a formal warning 🟨
              </div>
            )}
          </div>
          
          
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
                    
                    // Find which player on court this bench player replaced (if they were substituted in)
                    const substitutionWherePlayerIn = substitutions
                      .filter(s => String(s.payload?.playerIn) === String(player.number))
                      .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0] // Get most recent
                    const playerOnCourtReplaced = substitutionWherePlayerIn?.payload?.playerOut || null
                    
                    // Check if player was substituted due to expulsion (cannot re-enter for rest of set)
                    const wasExpelledSub = wasSubstitutedDueToExpulsion(teamKey, player.number)
                    const expulsionSub = wasExpelledSub ? data.events?.find(e => 
                      e.type === 'substitution' && 
                      e.payload?.team === teamKey &&
                      String(e.payload?.playerOut) === String(player.number) &&
                      e.payload?.isExpelled === true
                    ) : null
                    const isExpelledInSet = wasExpelledSub && expulsionSub && expulsionSub.setIndex === data.set.index
                    
                    // Check if player was substituted due to disqualification (cannot re-enter for rest of game)
                    const isDisqualifiedSub = wasSubstitutedDueToDisqualification(teamKey, player.number)
                    
                    // Check if player was exceptionally substituted (cannot re-enter for rest of game)
                    const isExceptionallySub = wasExceptionallySubstituted(teamKey, player.number)
                    
                    // Also check for sanction-based expulsion/disqualification (for display)
                    const hasExpulsionSanction = data.events?.some(e => 
                      e.type === 'sanction' && 
                      e.payload?.team === teamKey &&
                      e.payload?.playerNumber === player.number &&
                      e.payload?.type === 'expulsion' &&
                      e.setIndex === data.set.index
                    )
                    const hasDisqualificationSanction = data.events?.some(e => 
                      e.type === 'sanction' && 
                      e.payload?.team === teamKey &&
                      e.payload?.playerNumber === player.number &&
                      e.payload?.type === 'disqualification'
                    )
                    
                    // Show X if substituted due to expulsion, disqualification, or exceptional substitution
                    const showX = isExpelledInSet || isDisqualifiedSub || isExceptionallySub || hasExpulsionSanction || hasDisqualificationSanction
                    
                    // Get sanctions for this player
                    const sanctions = getPlayerSanctions(teamKey, player.number)
                    const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
                    const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
                    const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
                    const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')

                    // Determine if bench player can substitute
                    // Case 1: Player was substituted out - can only come back for the player who replaced them
                    // Case 2: Player never played - can substitute for any court player (if team has subs left)
                    // BUT: If player is currently replaced by libero, they cannot substitute at all
                    const neverPlayed = !wasSubstitutedOut && !hasComeBack && !isSubstitutedByLibero
                    const canComeBackFromSub = wasSubstitutedOut && canComeBack && !hasComeBack && !isSubstitutedByLibero
                    const canSubBenchPlayer = !showX && !isSubstitutedByLibero && (canComeBackFromSub || neverPlayed)

                    // Find the court player this bench player can swap with
                    let courtPlayerToSwapWith = null
                    if (canComeBackFromSub) {
                      // Player was substituted out - can only swap with the player who replaced them
                      const subEvent = substitutions
                        .filter(s => String(s.payload?.playerOut) === String(player.number))
                        .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0]
                      if (subEvent?.payload?.playerIn && subEvent?.payload?.position) {
                        courtPlayerToSwapWith = {
                          number: subEvent.payload.playerIn,
                          position: subEvent.payload.position
                        }
                      }
                    }
                    // For neverPlayed case, courtPlayerToSwapWith stays null - we'll show expandable list

                    return (
                      <div
                        key={`${teamKey}-bench-${player.id || player.number}`}
                        onClick={(e) => {
                          if (rallyStatus === 'idle') {
                            const rect = e.currentTarget.getBoundingClientRect()
                            setBenchPlayerActionMenu({
                              team: teamKey,
                              playerNumber: player.number,
                              element: e.currentTarget,
                              x: rect.right - 8,
                              y: rect.top - 8,
                              canSubstitute: canSubBenchPlayer,
                              courtPlayerToSwapWith: courtPlayerToSwapWith,
                              neverPlayed: neverPlayed
                            })
                          }
                        }}
                        style={{
                          padding: '4px 8px',
                          background: isSubstitutedByLibero
                            ? '#ffffff'  // White for libero-replaced
                            : wasSubstitutedOut
                              ? '#fde047'  // Yellow for substituted-out
                              : (hasComeBack || showX ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.05)'),
                          borderRadius: '4px',
                          fontSize: '11px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          position: 'relative',
                          opacity: (hasComeBack || showX) ? 0.4 : 1,
                          color: (isSubstitutedByLibero || wasSubstitutedOut) ? '#000' : undefined,
                          cursor: rallyStatus === 'idle' ? 'pointer' : 'default'
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{player.number}</span>
                        {player.isCaptain && (
                          <span style={{ color: (isSubstitutedByLibero || wasSubstitutedOut) ? '#000' : 'var(--accent)', fontSize: '10px', fontWeight: 700 }}>C</span>
                        )}
                        {isSubstitutedByLibero && (
                          <span style={{
                            fontSize: '9px',
                            fontWeight: 700,
                            color: '#000',
                            background: 'rgba(0, 0, 0, 0.1)',
                            padding: '1px 3px',
                            borderRadius: '2px'
                          }}>
                            {player.substitutedByLibero.liberoType === 'libero1' ? 'L1' : 'L2'}
                          </span>
                        )}
                        {showX && (
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
                            title={
                              isDisqualifiedSub || hasDisqualificationSanction 
                                ? 'Disqualified - cannot play rest of match' 
                                : isExceptionallySub 
                                  ? 'Exceptionally substituted - cannot play rest of match'
                                  : isExpelledInSet || hasExpulsionSanction
                                    ? 'Expelled - cannot play this set'
                                    : 'Cannot re-enter'
                            }
                          >
                            ✕
                          </span>
                        )}
                        {hasComeBack && !showX && (
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
                        {(waitingForPoint || canComeBack) && !hasComeBack && !showX && (
                          <span 
                            style={{ 
                              fontSize: '7px',
                              lineHeight: '1',
                              display: 'flex',
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: '2px',
                              background: 'rgba(15, 23, 42, 0.95)',
                              padding: '1px 3px',
                              borderRadius: '2px',
                              minHeight: '12px',
                              justifyContent: 'center',
                              border: '1px solid rgba(255, 255, 255, 0.2)',
                              opacity: waitingForPoint ? 0.5 : 1
                            }}
                          >
                            <span style={{ color: '#22c55e', fontWeight: 900 }}>↑</span>
                            <span style={{ color: '#ef4444', fontWeight: 900 }}>↓</span>
                            {playerOnCourtReplaced && (
                              <span style={{ 
                                color: 'rgba(255, 255, 255, 0.8)', 
                                fontSize: '8px', 
                                fontWeight: 600,
                                marginLeft: '2px'
                              }}>
                                {playerOnCourtReplaced}
                              </span>
                            )}
                          </span>
                        )}
                        {sanctions.length > 0 && (
                          <span style={{ 
                            fontSize: '8px',
                            display: 'flex',
                            gap: '1px',
                            alignItems: 'center'
                          }}>
                            {hasExpulsion ? (
                              <div style={{ position: 'relative', width: '9px', height: '9px' }}>
                                <div className="sanction-card yellow" style={{ 
                                  width: '6px', 
                                  height: '8px',
                                  position: 'absolute',
                                  left: '0',
                                  top: '0',
                                  transform: 'rotate(-8deg)',
                                  zIndex: 1
                                }}></div>
                                <div className="sanction-card red" style={{ 
                                  width: '6px', 
                                  height: '8px',
                                  position: 'absolute',
                                  right: '0',
                                  top: '0',
                                  transform: 'rotate(8deg)',
                                  zIndex: 2
                                }}></div>
                              </div>
                            ) : (
                              <>
                                {(hasWarning || hasDisqualification) && (
                              <div className="sanction-card yellow" style={{ width: '6px', height: '8px' }}></div>
                            )}
                                {(hasPenalty || hasDisqualification) && (
                              <div className="sanction-card red" style={{ width: '6px', height: '8px' }}></div>
                                )}
                              </>
                            )}
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
                  {leftTeamBench.liberos.map(player => {
                    const teamKey = leftIsHome ? 'home' : 'away'
                    const isUnable = isLiberoUnable(teamKey, player.number)
                    
                    // Get sanctions for this libero
                    const sanctions = getPlayerSanctions(teamKey, player.number)
                    const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
                    const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
                    const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
                    const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')
                    
                    return (
                      <div 
                        key={`${teamKey}-bench-libero-${player.id || player.number}`}
                        style={{ 
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}
                      >
                        <div 
                          onClick={(e) => {
                            if (rallyStatus === 'idle' && !isUnable) {
                              // Open action menu for libero on bench
                              const rect = e.currentTarget.getBoundingClientRect()
                              setLiberoBenchActionMenu({
                                team: teamKey,
                                liberoNumber: player.number,
                                liberoType: player.libero,
                                element: e.currentTarget,
                                x: rect.right + 8,
                                y: rect.top
                              })
                            }
                          }}
                          style={{ 
                            padding: '4px 8px', 
                            background: isUnable ? 'rgba(239, 68, 68, 0.2)' : 'rgba(59, 130, 246, 0.2)', 
                            borderRadius: '4px',
                            fontSize: '11px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            border: `1px solid ${isUnable ? 'rgba(239, 68, 68, 0.3)' : 'rgba(59, 130, 246, 0.3)'}`,
                            cursor: (rallyStatus === 'idle' && !isUnable) ? 'pointer' : 'default',
                            opacity: isUnable ? 0.6 : 1
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>{player.number}</span>
                          <span style={{ color: isUnable ? '#f87171' : '#60a5fa', fontSize: '10px', fontWeight: 700 }}>
                            {player.libero === 'libero1' ? 'L1' : 'L2'}
                          </span>
                          {sanctions.length > 0 && (
                            <span style={{ display: 'flex', gap: '1px', alignItems: 'center' }}>
                              {hasExpulsion ? (
                                <div style={{ position: 'relative', width: '9px', height: '9px' }}>
                                  <div className="sanction-card yellow" style={{ 
                                    width: '5px', 
                                    height: '7px',
                                    position: 'absolute',
                                    left: '0',
                                    top: '1px',
                                    transform: 'rotate(-8deg)',
                                    zIndex: 1,
                                    borderRadius: '1px'
                                  }}></div>
                                  <div className="sanction-card red" style={{ 
                                    width: '5px', 
                                    height: '7px',
                                    position: 'absolute',
                                    right: '0',
                                    top: '1px',
                                    transform: 'rotate(8deg)',
                                    zIndex: 2,
                                    borderRadius: '1px'
                                  }}></div>
                                </div>
                              ) : (
                                <>
                                  {(hasWarning || hasDisqualification) && (
                                    <div className="sanction-card yellow" style={{ width: '6px', height: '8px', borderRadius: '1px' }}></div>
                                  )}
                                  {(hasPenalty || hasDisqualification) && (
                                    <div className="sanction-card red" style={{ width: '6px', height: '8px', borderRadius: '1px' }}></div>
                                  )}
                                </>
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            
            {/* Bench Officials */}
            {leftTeamBench.benchOfficials.length > 0 && (
              <div>
                <h4 style={{ margin: '0 0 8px', fontSize: '12px', fontWeight: 600, color: 'var(--muted)' }}>Bench Officials</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {leftTeamBench.benchOfficials.map((official, idx) => {
                    const teamKey = leftIsHome ? 'home' : 'away'
                    
                    // Get sanctions for this official
                    const sanctions = getPlayerSanctions(teamKey, null, official.role)
                    const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
                    const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
                    const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
                    const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')
                    
                    return (
                      <div 
                        key={idx} 
                        onClick={(e) => {
                          if (rallyStatus === 'idle') {
                            const rect = e.currentTarget.getBoundingClientRect()
                            setSanctionDropdown({
                              team: teamKey,
                              type: 'official',
                              role: official.role,
                              element: e.currentTarget,
                              x: rect.right - 8,
                              y: rect.top - 8
                            })
                          }
                        }}
                        style={{ 
                          padding: '4px 8px', 
                          background: 'rgba(255,255,255,0.05)', 
                          borderRadius: '4px',
                          fontSize: '11px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          cursor: rallyStatus === 'idle' ? 'pointer' : 'default'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontWeight: 600, color: 'var(--muted)', minWidth: '30px' }}>
                            {official.role === 'Coach' ? 'C' : 
                             official.role === 'Assistant Coach 1' ? 'AC1' :
                             official.role === 'Assistant Coach 2' ? 'AC2' :
                             official.role === 'Physiotherapist' ? 'P' :
                             official.role === 'Medic' ? 'M' : official.role}
                          </span>
                          <span>{official.lastName || ''} {official.firstName || ''}</span>
                          {sanctions.length > 0 && (
                            <span style={{ display: 'flex', gap: '1px', alignItems: 'center' }}>
                              {hasExpulsion ? (
                                <div style={{ position: 'relative', width: '9px', height: '9px' }}>
                                  <div className="sanction-card yellow" style={{ 
                                    width: '5px', 
                                    height: '7px',
                                    position: 'absolute',
                                    left: '0',
                                    top: '1px',
                                    transform: 'rotate(-8deg)',
                                    zIndex: 1,
                                    borderRadius: '1px'
                                  }}></div>
                                  <div className="sanction-card red" style={{ 
                                    width: '5px', 
                                    height: '7px',
                                    position: 'absolute',
                                    right: '0',
                                    top: '1px',
                                    transform: 'rotate(8deg)',
                                    zIndex: 2,
                                    borderRadius: '1px'
                                  }}></div>
                                </div>
                              ) : (
                                <>
                                  {(hasWarning || hasDisqualification) && (
                                    <div className="sanction-card yellow" style={{ width: '6px', height: '8px', borderRadius: '1px' }}></div>
                                  )}
                                  {(hasPenalty || hasDisqualification) && (
                                    <div className="sanction-card red" style={{ width: '6px', height: '8px', borderRadius: '1px' }}></div>
                                  )}
                                </>
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </ScoreboardTeamColumn>

        <ScoreboardCourtColumn>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '16px', width: '100%' }}>
            {/* SERVE indicator container - Left (fixed width) */}
            <div style={{
              width: '100px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}>
              {leftServing && (() => {
                const servingPlayer = leftTeam.playersOnCourt.find(p => p.position === 'I')
                if (!servingPlayer || !servingPlayer.number) return null
                return (
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '8px',
                    zIndex: 10,
                    pointerEvents: 'none'
                  }}>
                    <div style={{
                      fontSize: '24px',
                      fontWeight: 700,
                      color: 'var(--text)',
                      textTransform: 'uppercase',
                      letterSpacing: '2px'
                    }}>
                      SERVE
                    </div>
                    <div style={{
                      fontSize: '36px',
                      fontWeight: 700,
                      color: 'var(--accent)',
                      width: '64px',
                      height: '64px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'rgba(34, 197, 94, 0.1)',
                      border: '4px solid var(--accent)',
                      borderRadius: '16px'
                    }}>
                      {servingPlayer.number}
                    </div>
                  </div>
                )
              })()}
            </div>

            <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <div className="set-summary">
                <div className="set-info">
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', width: '100%' }}>
                    {/* Current score */}
                    {renderScoreDisplay({ margin: '0 auto' })}
                  </div>
                </div>
                <div style={{ marginTop: '4px' }}>
                  <span className="summary-label">Rally status:</span>
                  <span className="summary-value" style={{ color: rallyStatus === 'in_play' ? '#4ade80' : '#fb923c' }}>
                    {rallyStatus === 'in_play' ? 'In play' : 'Not in play'}
                  </span>
                </div>
                {/* Last action */}
                {data?.events && data.events.length > 0 && (() => {
                  // Find the last undoable event by sequence number
                  const allEvents = [...data.events].sort((a, b) => {
                    const aSeq = a.seq || 0
                    const bSeq = b.seq || 0
                    if (aSeq !== 0 || bSeq !== 0) {
                      return bSeq - aSeq // Descending
                    }
                    // Fallback to timestamp
                    const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
                    const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
                    return bTime - aTime
                  })
                  
                  // Find events with valid descriptions
                  let lastEvent = null
                  for (const e of allEvents) {
                    // Skip rally_start and replay from display
                    if (e.type === 'rally_start' || e.type === 'replay') continue
                    
                    // For lineup events, only show initial or substitution
                    if (e.type === 'lineup') {
                      const hasInitial = e.payload?.isInitial === true
                      const hasSubstitution = e.payload?.fromSubstitution === true
                      if (!hasInitial && !hasSubstitution) continue
                    }
                    
                    // Try to get description
                    const desc = getActionDescription(e)
                    if (desc && desc !== 'Unknown action') {
                      lastEvent = e
                      break
                    }
                  }
                  
                  if (!lastEvent) return null
                  
                  const description = getActionDescription(lastEvent)
                  
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

              {/* 1st Referee - Between the court and Last action */}
              {refereeConnectionEnabled && (() => {
                const ref1 = data?.match?.officials?.find(o => o.role === '1st referee' || o.role === '1st Referee')
                const ref1Name = ref1 ? `${ref1.firstName || ''} ${ref1.lastName || ''}` : 'N/A'
                const ref1Status = isReferee1Connected
                const ref1StatusColor = ref1Status ? '#22c55e' : '#eab308'
                
                return (
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    marginTop: '8px',
                    marginBottom: '0',
                    zIndex: 10,
                    gap: '8px'
                  }}>
                    <div 
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '6px 12px',
                        background: 'rgba(255, 255, 255, 0.1)',
                        borderRadius: '6px',
                        border: '1px solid rgba(255, 255, 255, 0.2)'
                      }}
                    >
                      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text)' }}>
                        1<sup><small><small>st</small></small></sup> Ref: {ref1Name}
                      </span>
                    </div>
                  </div>
                )
              })()}
            </div>

            {/* SERVE indicator container - Right (fixed width) */}
            <div style={{
              width: '100px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}>
              {rightServing && (() => {
                const servingPlayer = rightTeam.playersOnCourt.find(p => p.position === 'I')
                if (!servingPlayer || !servingPlayer.number) return null
                return (
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '8px',
                    zIndex: 10,
                    pointerEvents: 'none'
                  }}>
                    <div style={{
                      fontSize: '24px',
                      fontWeight: 700,
                      color: 'var(--text)',
                      textTransform: 'uppercase',
                      letterSpacing: '2px'
                    }}>
                      SERVE
                    </div>
                    <div style={{
                      fontSize: '36px',
                      fontWeight: 700,
                      color: 'var(--accent)',
                      width: '64px',
                      height: '64px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'rgba(34, 197, 94, 0.1)',
                      border: '4px solid var(--accent)',
                      borderRadius: '16px'
                    }}>
                      {servingPlayer.number}
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>

          <div className="court" style={{ marginTop: '-14px', marginBottom: '-14px' }}>
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
                  {leftTeam.playersOnCourt.slice(0, 3).map((player, idx) => {
                    const teamKey = leftIsHome ? 'home' : 'away'
                    const teamSubstitutions = substitutionsUsed?.[teamKey] || 0
                    const canSubstitute = rallyStatus === 'idle' && !isRallyReplayed && leftTeamLineupSet && player.number && player.number !== '' && !player.isPlaceholder && teamSubstitutions < 6
                    const replacementNumber = resolveReplacementNumber(player, leftTeamActiveReplacements)
                    
                    // Get sanctions for this player
                    const sanctions = getPlayerSanctions(teamKey, player.number)
                    const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
                    const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
                    const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
                    const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')
                    
                    return (
                      <div 
                        key={`${teamKey}-court-front-${player.position}-${player.id || player.number || idx}`} 
                        className="court-player"
                        onClick={(e) => handlePlayerClick(teamKey, player.position, player.number, e)}
                        style={{ 
                          cursor: 'pointer',
                          transition: 'transform 0.2s',
                          background: player.isLibero ? '#FFF8E7' : undefined,
                          color: player.isLibero ? '#000' : undefined,
                          position: 'relative'
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.transform = 'scale(1.05)'
                            e.currentTarget.style.boxShadow = '0 4px 12px rgba(255,255,255,0.2)'
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.transform = 'scale(1)'
                            e.currentTarget.style.boxShadow = 'none'
                        }}
                      >
                        {replacementNumber && (
                          <span style={getReplacementBadgeStyle(player)}>
                            {replacementNumber}
                          </span>
                        )}
                        <span className="court-player-position">{player.position}</span>
                        {/* Captain indicator */}
                        {player.isCaptain && (() => {
                          if (player.isLibero) {
                            const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
                            const liberoCount = teamPlayers?.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
                            const liberoLabel = liberoCount === 1 ? 'L' : (player.liberoType === 'libero1' ? 'L1' : 'L2')
                            return (
                              <span className="court-player-captain" style={{ width: '20px' }}>{liberoLabel}</span>
                            )
                          }
                          return <span className="court-player-captain">C</span>
                        })()}
                        {/* Captain on Court indicator (different color) */}
                        {(() => {
                          const courtCaptainField = teamKey === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain'
                          const courtCaptain = data?.match?.[courtCaptainField]
                          const isCourtCaptain = courtCaptain && Number(courtCaptain) === Number(player.number) && !player.isCaptain
                          if (isCourtCaptain) {
                            return (
                              <span 
                                className="court-player-captain" 
                                style={{ 
                                  color: '#fbbf24', // Different color (amber/yellow)
                                  borderColor: '#fbbf24'
                                }}
                              >
                                C
                              </span>
                            )
                          }
                          return null
                        })()}
                        {/* Libero indicator (bottom-left) - only if not captain */}
                        {player.isLibero && !player.isCaptain && (() => {
                          const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
                          const liberoCount = teamPlayers?.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
                          const liberoLabel = liberoCount === 1 ? 'L' : (player.liberoType === 'libero1' ? 'L1' : 'L2')
                          return (
                            <span style={{
                              position: 'absolute',
                              bottom: '-8px',
                              left: '-8px',
                              width: '18px',
                              height: '18px',
                              background: '#3b82f6',
                              border: '2px solid rgba(255, 255, 255, 0.4)',
                              borderRadius: '4px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '10px',
                              fontWeight: 700,
                              color: '#fff',
                              zIndex: 5,
                              boxShadow: '0 2px 6px rgba(0, 0, 0, 0.4)'
                            }}>
                              {liberoLabel}
                            </span>
                          )
                        })()}
                        {player.number}
                        
                        {/* Sanction cards indicator */}
                        {sanctions.length > 0 && (
                          <div style={{
                            position: 'absolute',
                            bottom: '-6px',
                            right: '-6px',
                            zIndex: 10
                          }}>
                            {hasExpulsion ? (
                              // Expulsion: overlapping rotated cards
                              <div style={{ position: 'relative', width: '12px', height: '12px' }}>
                                <div className="sanction-card yellow" style={{ 
                                  width: '6px', 
                                  height: '9px', 
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                  position: 'absolute',
                                  left: '0',
                                  top: '1px',
                                  transform: 'rotate(-8deg)',
                                  zIndex: 1,
                                  borderRadius: '1px'
                                }}></div>
                                <div className="sanction-card red" style={{ 
                                  width: '6px', 
                                  height: '9px', 
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                  position: 'absolute',
                                  right: '0',
                                  top: '1px',
                                  transform: 'rotate(8deg)',
                                  zIndex: 2,
                                  borderRadius: '1px'
                                }}></div>
                              </div>
                            ) : (
                              // Other sanctions: separate cards
                              <div style={{ display: 'flex', gap: '1px' }}>
                                {(hasWarning || hasDisqualification) && (
                                  <div className="sanction-card yellow" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', borderRadius: '1px' }}></div>
                                )}
                                {(hasPenalty || hasDisqualification) && (
                                  <div className="sanction-card red" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', borderRadius: '1px' }}></div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <div className="court-row court-row-back">
                  {leftTeam.playersOnCourt.slice(3, 6).map((player, idx) => {
                    const leftTeamKey = leftIsHome ? 'home' : 'away'
                    const currentServe = getCurrentServe()
                    const leftTeamServes = currentServe === leftTeamKey
                    const shouldShowBall = player.position === 'I' && leftTeamServes
                    const teamSubstitutions = substitutionsUsed?.[leftTeamKey] || 0
                    const canSubstitute = rallyStatus === 'idle' && !isRallyReplayed && leftTeamLineupSet && player.number && player.number !== '' && !player.isPlaceholder && teamSubstitutions < 6
                    const replacementNumber = resolveReplacementNumber(player, leftTeamActiveReplacements)
                    
                    // Get sanctions for this player
                    const sanctions = getPlayerSanctions(leftTeamKey, player.number)
                    const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
                    const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
                    const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
                    const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')
                    
                    return (
                      <div 
                        key={`${leftTeamKey}-court-back-${player.position}-${player.id || player.number || idx}`} 
                        className="court-player" 
                        style={{ 
                          position: 'relative',
                          cursor: player.number && player.number !== '' ? 'pointer' : 'default',
                          transition: 'transform 0.2s',
                          background: player.isLibero ? '#FFF8E7' : undefined,
                          color: player.isLibero ? '#000' : undefined
                        }}
                        onClick={(e) => handlePlayerClick(leftTeamKey, player.position, player.number, e)}
                        onMouseEnter={(e) => {
                          if (player.number && player.number !== '') {
                            e.currentTarget.style.transform = 'scale(1.05)'
                            e.currentTarget.style.boxShadow = '0 4px 12px rgba(255,255,255,0.2)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (player.number && player.number !== '') {
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
                        {replacementNumber && (
                          <span style={getReplacementBadgeStyle(player)}>
                            {replacementNumber}
                          </span>
                        )}
                        <span className="court-player-position">{player.position}</span>
                        {/* Captain indicator */}
                        {player.isCaptain && (() => {
                          if (player.isLibero) {
                            const teamPlayers = leftTeamKey === 'home' ? data?.homePlayers : data?.awayPlayers
                            const liberoCount = teamPlayers?.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
                            const liberoLabel = liberoCount === 1 ? 'L' : (player.liberoType === 'libero1' ? 'L1' : 'L2')
                            return (
                              <span className="court-player-captain" style={{ width: '20px' }}>{liberoLabel}</span>
                            )
                          }
                          return <span className="court-player-captain">C</span>
                        })()}
                        {/* Captain on Court indicator (different color) */}
                        {(() => {
                          const courtCaptainField = leftTeamKey === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain'
                          const courtCaptain = data?.match?.[courtCaptainField]
                          const isCourtCaptain = courtCaptain && Number(courtCaptain) === Number(player.number) && !player.isCaptain
                          if (isCourtCaptain) {
                            return (
                              <span 
                                className="court-player-captain" 
                                style={{ 
                                  color: '#fbbf24', // Different color (amber/yellow)
                                  borderColor: '#fbbf24'
                                }}
                              >
                                C
                              </span>
                            )
                          }
                          return null
                        })()}
                        {/* Libero indicator (bottom-left) - only if not captain */}
                        {player.isLibero && !player.isCaptain && (() => {
                          const teamPlayers = leftTeamKey === 'home' ? data?.homePlayers : data?.awayPlayers
                          const liberoCount = teamPlayers?.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
                          const liberoLabel = liberoCount === 1 ? 'L' : (player.liberoType === 'libero1' ? 'L1' : 'L2')
                          return (
                            <span style={{
                              position: 'absolute',
                              bottom: '-8px',
                              left: '-8px',
                              width: '18px',
                              height: '18px',
                              background: '#3b82f6',
                              border: '2px solid rgba(255, 255, 255, 0.4)',
                              borderRadius: '4px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '10px',
                              fontWeight: 700,
                              color: '#fff',
                              zIndex: 5,
                              boxShadow: '0 2px 6px rgba(0, 0, 0, 0.4)'
                            }}>
                              {liberoLabel}
                            </span>
                          )
                        })()}
                        {player.number}
                        
                        {/* Sanction cards indicator */}
                        {sanctions.length > 0 && (
                          <div style={{
                            position: 'absolute',
                            bottom: '-6px',
                            right: '-6px',
                            zIndex: 10
                          }}>
                            {hasExpulsion ? (
                              // Expulsion: overlapping rotated cards
                              <div style={{ position: 'relative', width: '12px', height: '12px' }}>
                                <div className="sanction-card yellow" style={{ 
                                  width: '6px', 
                                  height: '9px', 
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                  position: 'absolute',
                                  left: '0',
                                  top: '1px',
                                  transform: 'rotate(-8deg)',
                                  zIndex: 1,
                                  borderRadius: '1px'
                                }}></div>
                                <div className="sanction-card red" style={{ 
                                  width: '6px', 
                                  height: '9px', 
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                  position: 'absolute',
                                  right: '0',
                                  top: '1px',
                                  transform: 'rotate(8deg)',
                                  zIndex: 2,
                                  borderRadius: '1px'
                                }}></div>
                              </div>
                            ) : (
                              // Other sanctions: separate cards
                              <div style={{ display: 'flex', gap: '1px' }}>
                                {(hasWarning || hasDisqualification) && (
                                  <div className="sanction-card yellow" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', borderRadius: '1px' }}></div>
                                )}
                                {(hasPenalty || hasDisqualification) && (
                                  <div className="sanction-card red" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', borderRadius: '1px' }}></div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
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
                  {rightTeam.playersOnCourt.slice(0, 3).map((player, idx) => {
                    const teamKey = leftIsHome ? 'away' : 'home'
                    const teamSubstitutions = substitutionsUsed?.[teamKey] || 0
                    const canSubstitute = rallyStatus === 'idle' && !isRallyReplayed && rightTeamLineupSet && player.number && player.number !== '' && !player.isPlaceholder && teamSubstitutions < 6
                    const replacementNumber = resolveReplacementNumber(player, rightTeamActiveReplacements)
                    
                    // Get sanctions for this player
                    const sanctions = getPlayerSanctions(teamKey, player.number)
                    const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
                    const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
                    const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
                    const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')
                    
                    return (
                      <div 
                        key={`${teamKey}-court-front-${player.position}-${player.id || player.number || idx}`} 
                        className="court-player"
                        onClick={(e) => handlePlayerClick(teamKey, player.position, player.number, e)}
                        style={{ 
                          cursor: 'pointer',
                          transition: 'transform 0.2s',
                          background: player.isLibero ? '#FFF8E7' : undefined,
                          color: player.isLibero ? '#000' : undefined,
                          position: 'relative'
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.transform = 'scale(1.05)'
                            e.currentTarget.style.boxShadow = '0 4px 12px rgba(255,255,255,0.2)'
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.transform = 'scale(1)'
                            e.currentTarget.style.boxShadow = 'none'
                        }}
                      >
                        {replacementNumber && (
                          <span style={getReplacementBadgeStyle(player)}>
                            {replacementNumber}
                          </span>
                        )}
                        <span className="court-player-position">{player.position}</span>
                        {/* Bottom-left indicators: Captain C */}
                        {player.isCaptain && (() => {
                          if (player.isLibero) {
                            const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
                            const liberoCount = teamPlayers?.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
                            const liberoLabel = liberoCount === 1 ? 'L' : (player.liberoType === 'libero1' ? 'L1' : 'L2')
                            return (
                              <span className="court-player-captain" style={{ width: '20px' }}>{liberoLabel}</span>
                            )
                          }
                          return <span className="court-player-captain">C</span>
                        })()}
                        {/* Captain on Court indicator (different color) */}
                        {(() => {
                          const courtCaptainField = teamKey === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain'
                          const courtCaptain = data?.match?.[courtCaptainField]
                          const isCourtCaptain = courtCaptain && Number(courtCaptain) === Number(player.number) && !player.isCaptain
                          if (isCourtCaptain) {
                            return (
                              <span 
                                className="court-player-captain" 
                                style={{ 
                                  color: '#fbbf24', // Different color (amber/yellow)
                                  borderColor: '#fbbf24'
                                }}
                              >
                                C
                              </span>
                            )
                          }
                          return null
                        })()}
                        {/* Libero indicator (bottom-left) - only if not captain */}
                        {player.isLibero && !player.isCaptain && (() => {
                          const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
                          const liberoCount = teamPlayers?.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
                          const liberoLabel = liberoCount === 1 ? 'L' : (player.liberoType === 'libero1' ? 'L1' : 'L2')
                          return (
                            <span style={{
                              position: 'absolute',
                              bottom: '-8px',
                              left: '-8px',
                              width: '18px',
                              height: '18px',
                              background: '#3b82f6',
                              border: '2px solid rgba(255, 255, 255, 0.4)',
                              borderRadius: '4px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '10px',
                              fontWeight: 700,
                              color: '#fff',
                              zIndex: 5,
                              boxShadow: '0 2px 6px rgba(0, 0, 0, 0.4)'
                            }}>
                              {liberoLabel}
                            </span>
                          )
                        })()}
                        {player.number}
                        
                        {/* Sanction cards indicator */}
                        {sanctions.length > 0 && (
                          <div style={{
                            position: 'absolute',
                            bottom: '-6px',
                            right: '-6px',
                            zIndex: 10
                          }}>
                            {hasExpulsion ? (
                              // Expulsion: overlapping rotated cards
                              <div style={{ position: 'relative', width: '12px', height: '12px' }}>
                                <div className="sanction-card yellow" style={{ 
                                  width: '6px', 
                                  height: '9px', 
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                  position: 'absolute',
                                  left: '0',
                                  top: '1px',
                                  transform: 'rotate(-8deg)',
                                  zIndex: 1,
                                  borderRadius: '1px'
                                }}></div>
                                <div className="sanction-card red" style={{ 
                                  width: '6px', 
                                  height: '9px', 
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                  position: 'absolute',
                                  right: '0',
                                  top: '1px',
                                  transform: 'rotate(8deg)',
                                  zIndex: 2,
                                  borderRadius: '1px'
                                }}></div>
                              </div>
                            ) : (
                              // Other sanctions: separate cards
                              <div style={{ display: 'flex', gap: '1px' }}>
                                {(hasWarning || hasDisqualification) && (
                                  <div className="sanction-card yellow" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', borderRadius: '1px' }}></div>
                                )}
                                {(hasPenalty || hasDisqualification) && (
                                  <div className="sanction-card red" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', borderRadius: '1px' }}></div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <div className="court-row court-row-back">
                  {rightTeam.playersOnCourt.slice(3, 6).map((player, idx) => {
                    const rightTeamKey = leftIsHome ? 'away' : 'home'
                    const currentServe = getCurrentServe()
                    const rightTeamServes = currentServe === rightTeamKey
                    const shouldShowBall = player.position === 'I' && rightTeamServes
                    const teamSubstitutions = substitutionsUsed?.[rightTeamKey] || 0
                    const canSubstitute = rallyStatus === 'idle' && rightTeamLineupSet && player.number && player.number !== '' && !player.isPlaceholder && teamSubstitutions < 6
                    const replacementNumber = resolveReplacementNumber(player, rightTeamActiveReplacements)
                    
                    // Get sanctions for this player
                    const sanctions = getPlayerSanctions(rightTeamKey, player.number)
                    const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
                    const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
                    const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
                    const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')
                    
                    return (
                      <div 
                        key={`${rightTeamKey}-court-back-${player.position}-${player.id || player.number || idx}`} 
                        className="court-player" 
                        style={{ 
                          position: 'relative',
                          cursor: player.number && player.number !== '' ? 'pointer' : 'default',
                          transition: 'transform 0.2s',
                          background: player.isLibero ? '#FFF8E7' : undefined,
                          color: player.isLibero ? '#000' : undefined
                        }}
                        onClick={(e) => handlePlayerClick(rightTeamKey, player.position, player.number, e)}
                        onMouseEnter={(e) => {
                          if (player.number && player.number !== '') {
                            e.currentTarget.style.transform = 'scale(1.05)'
                            e.currentTarget.style.boxShadow = '0 4px 12px rgba(255,255,255,0.2)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (player.number && player.number !== '') {
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
                        {replacementNumber && (
                          <span style={getReplacementBadgeStyle(player)}>
                            {replacementNumber}
                          </span>
                        )}
                        <span className="court-player-position">{player.position}</span>
                        {player.isCaptain && (() => {
                          if (player.isLibero) {
                            const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
                            const liberoCount = teamPlayers?.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
                            const liberoLabel = liberoCount === 1 ? 'L' : (player.liberoType === 'libero1' ? 'L1' : 'L2')
                            return (
                              <span className="court-player-captain" style={{ width: '20px' }}>{liberoLabel}</span>
                            )
                          }
                          return <span className="court-player-captain">C</span>
                        })()}
                        {/* Captain on Court indicator (different color) */}
                        {(() => {
                          const courtCaptainField = rightTeamKey === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain'
                          const courtCaptain = data?.match?.[courtCaptainField]
                          const isCourtCaptain = courtCaptain && Number(courtCaptain) === Number(player.number) && !player.isCaptain
                          if (isCourtCaptain) {
                            return (
                              <span 
                                className="court-player-captain" 
                                style={{ 
                                  color: '#fbbf24', // Different color (amber/yellow)
                                  borderColor: '#fbbf24'
                                }}
                              >
                                C
                              </span>
                            )
                          }
                          return null
                        })()}
                        {/* Libero indicator (bottom-left) */}
                        {player.isLibero && !player.isCaptain && (() => {
                          const teamPlayers = rightTeamKey === 'home' ? data?.homePlayers : data?.awayPlayers
                          const liberoCount = teamPlayers?.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
                          const liberoLabel = liberoCount === 1 ? 'L' : (player.liberoType === 'libero1' ? 'L1' : 'L2')
                          return (
                            <span style={{
                              position: 'absolute',
                              bottom: '-8px',
                              left: '-8px',
                              width: '18px',
                              height: '18px',
                              background: '#3b82f6',
                              border: '2px solid rgba(255, 255, 255, 0.4)',
                              borderRadius: '4px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '10px',
                              fontWeight: 700,
                              color: '#fff',
                              zIndex: 5,
                              boxShadow: '0 2px 6px rgba(0, 0, 0, 0.4)'
                            }}>
                              {liberoLabel}
                            </span>
                          )
                        })()}
                        {player.number}
                        
                        {/* Sanction cards indicator */}
                        {sanctions.length > 0 && (
                          <div style={{
                            position: 'absolute',
                            bottom: '-6px',
                            right: '-6px',
                            zIndex: 10
                          }}>
                            {hasExpulsion ? (
                              // Expulsion: overlapping rotated cards
                              <div style={{ position: 'relative', width: '12px', height: '12px' }}>
                                <div className="sanction-card yellow" style={{ 
                                  width: '6px', 
                                  height: '9px', 
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                  position: 'absolute',
                                  left: '0',
                                  top: '1px',
                                  transform: 'rotate(-8deg)',
                                  zIndex: 1,
                                  borderRadius: '1px'
                                }}></div>
                                <div className="sanction-card red" style={{ 
                                  width: '6px', 
                                  height: '9px', 
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                  position: 'absolute',
                                  right: '0',
                                  top: '1px',
                                  transform: 'rotate(8deg)',
                                  zIndex: 2,
                                  borderRadius: '1px'
                                }}></div>
                              </div>
                            ) : (
                              // Other sanctions: separate cards
                              <div style={{ display: 'flex', gap: '1px' }}>
                                {(hasWarning || hasDisqualification) && (
                                  <div className="sanction-card yellow" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', borderRadius: '1px' }}></div>
                                )}
                                {(hasPenalty || hasDisqualification) && (
                                  <div className="sanction-card red" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', borderRadius: '1px' }}></div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* 2nd Referee - Between the court and rally-controls */}
          {refereeConnectionEnabled && (() => {
            const ref2 = data?.match?.officials?.find(o => o.role === '2nd referee' || o.role === '2nd Referee')
            const ref2Name = ref2 ? `${ref2.firstName || ''} ${ref2.lastName || ''}` : 'N/A'
            const ref2Status = isReferee2Connected
            const ref2StatusColor = ref2Status ? '#22c55e' : '#eab308'
            
            return (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                marginTop: '0.1px',
                marginBottom: '0.1px',
                zIndex: 10,
                gap: '8px'
              }}>
                <div 
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    background: 'rgba(255, 255, 255, 0.1)',
                    borderRadius: '6px',
                    border: '1px solid rgba(255, 255, 255, 0.2)'
                  }}
                >
                  <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text)' }}>
                    2<sup><small><small>nd</small></small></sup> Ref: {ref2Name}
                  </span>
                </div>
              </div>
            )
          })()}

          <div style={{ 
            display: 'flex', 
            alignItems: 'stretch', 
            gap: '16px',
            width: '100%',
            minHeight: '200px'
          }}>
            {/* Set Results Table - Left Team */}
            <div style={{ 
              flex: '0 0 auto',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center'
            }}>
              {(() => {
                // Get current left team
                const currentLeftTeamKey = leftIsHome ? 'home' : 'away'
                const leftTeamData = currentLeftTeamKey === 'home' ? data?.homeTeam : data?.awayTeam
                const leftTeamColor = leftTeamData?.color || (currentLeftTeamKey === 'home' ? '#ef4444' : '#3b82f6')
                const leftTeamLabel = currentLeftTeamKey === teamAKey ? 'A' : 'B'
                
                // Get all sets, filter to show only current set and previous sets
                // Also deduplicate by index (keep the latest one for each index)
                const allSets = (data?.sets || []).sort((a, b) => a.index - b.index)
                const currentSetIndex = data?.set?.index || 1
                const setsByIndex = new Map()
                allSets.forEach(set => {
                  if (set.index <= currentSetIndex) {
                    setsByIndex.set(set.index, set) // Later entries overwrite earlier ones
                  }
                })
                const visibleSets = Array.from(setsByIndex.values()).sort((a, b) => a.index - b.index)
                
                return (
                  <div style={{ 
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '8px',
                    padding: '12px',
                    fontSize: '9px'
                  }}>
                    <h4 style={{ margin: '0 0 8px', fontSize: '11px', fontWeight: 600, textAlign: 'center' }}>
                      <span style={{ 
                        padding: '2px 8px', 
                        borderRadius: '4px', 
                        fontSize: '10px', 
                        fontWeight: 700, 
                        background: leftTeamColor, 
                        color: isBrightColor(leftTeamColor) ? '#000' : '#fff' 
                      }}>{leftTeamLabel}</span>
                    </h4>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '9px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid rgba(255,255,255,0.2)' }}>
                          <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>Set</th>
                          <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>P</th>
                          <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>W</th>
                          <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>S</th>
                          <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>T</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleSets.map(set => {
                          const leftPoints = currentLeftTeamKey === 'home' ? set.homePoints : set.awayPoints
                          const rightPoints = currentLeftTeamKey === 'home' ? set.awayPoints : set.homePoints
                          const won = leftPoints > rightPoints ? 1 : 0
                          const substitutions = (data?.events || []).filter(e => 
                            e.type === 'substitution' && e.setIndex === set.index && e.payload?.team === currentLeftTeamKey
                          ).length
                          const timeouts = (data?.events || []).filter(e => 
                            e.type === 'timeout' && e.setIndex === set.index && e.payload?.team === currentLeftTeamKey
                          ).length
                          
                          // Determine row color based on set status
                          let rowColor = 'inherit'
                          if (set.finished) {
                            rowColor = won === 1 ? '#22c55e' : '#ef4444' // Green if won, red if lost
                          }
                          
                          return (
                            <tr key={set.id} style={{ 
                              borderBottom: '1px solid rgba(255,255,255,0.1)',
                              color: rowColor
                            }}>
                              <td style={{ padding: '4px 2px', textAlign: 'center' }}>{set.index}</td>
                              <td style={{ padding: '4px 2px', textAlign: 'center' }}>{leftPoints}</td>
                              <td style={{ padding: '4px 2px', textAlign: 'center' }}>{won}</td>
                              <td style={{ padding: '4px 2px', textAlign: 'center' }}>{substitutions}</td>
                              <td style={{ padding: '4px 2px', textAlign: 'center' }}>{timeouts}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              })()}
            </div>

            {/* Rally Controls - Center */}
            <div className="rally-controls" style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              {/* Show timeout countdown if timeout is active */}
              {timeoutModal && timeoutModal.started ? (
                <>
                  <div style={{
                    fontSize: '48px',
                    fontWeight: 700,
                    color: 'var(--accent)',
                    textAlign: 'center',
                    marginBottom: '16px',
                    fontFamily: 'monospace'
                  }}>
                    {formatCountdown(timeoutModal.countdown)}
                  </div>
                  <button
                    className="secondary"
                    onClick={stopTimeout}
                    style={{ width: 'auto' }}
                  >
                    Stop timeout
                  </button>
                </>
              ) : betweenSetsCountdown ? (
                <>
                  <div style={{
                    fontSize: '48px',
                    fontWeight: 700,
                    color: betweenSetsCountdown.countdown <= 0 ? '#ef4444' : 'var(--accent)',
                    textAlign: 'center',
                    marginBottom: '16px',
                    fontFamily: 'monospace'
                  }}>
                    {betweenSetsCountdown.countdown <= 0 ? "0''" : formatCountdown(betweenSetsCountdown.countdown)}
                  </div>
                  <button
                    className="secondary"
                    onClick={endSetInterval}
                    style={{ width: 'auto' }}
                  >
                    End set interval
                  </button>
                </>
              ) : (
                <>
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
                        <button className="rally-point-button" onClick={() => handlePoint('left')}>
                          Point {teamALabel}
                        </button>
                        <button className="rally-point-button" onClick={() => handlePoint('right')}>
                          Point {teamBLabel}
                        </button>
                      </div>
                    </>
                  )}
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {(rallyStatus === 'in_play' || (rallyStatus === 'idle' && canReplayRally)) && (
                      <button
                        className="secondary"
                        onClick={handleReplay}
                        style={{ flex: 1 }}
                      >
                        Replay
                      </button>
                    )}
                    <button
                      className="danger"
                      onClick={showUndoConfirm}
                      disabled={!data?.events || data.events.length === 0}
                      style={{ flex: (rallyStatus === 'in_play' || (rallyStatus === 'idle' && canReplayRally)) ? 1 : 'none' }}
                    >
                      Undo
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Set Results Table - Right Team */}
            <div style={{ 
              flex: '0 0 auto',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center'
            }}>
              {(() => {
                // Get current right team
                const currentRightTeamKey = leftIsHome ? 'away' : 'home'
                const rightTeamData = currentRightTeamKey === 'home' ? data?.homeTeam : data?.awayTeam
                const rightTeamColor = rightTeamData?.color || (currentRightTeamKey === 'home' ? '#ef4444' : '#3b82f6')
                const rightTeamLabel = currentRightTeamKey === teamAKey ? 'A' : 'B'
                
                // Get all sets, filter to show only current set and previous sets
                // Also deduplicate by index (keep the latest one for each index)
                const allSets = (data?.sets || []).sort((a, b) => a.index - b.index)
                const currentSetIndex = data?.set?.index || 1
                const setsByIndex = new Map()
                allSets.forEach(set => {
                  if (set.index <= currentSetIndex) {
                    setsByIndex.set(set.index, set) // Later entries overwrite earlier ones
                  }
                })
                const visibleSets = Array.from(setsByIndex.values()).sort((a, b) => a.index - b.index)
                
                return (
                  <div style={{ 
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '8px',
                    padding: '12px',
                    fontSize: '9px'
                  }}>
                    <h4 style={{ margin: '0 0 8px', fontSize: '11px', fontWeight: 600, textAlign: 'center' }}>
                      <span style={{ 
                        padding: '2px 8px', 
                        borderRadius: '4px', 
                        fontSize: '10px', 
                        fontWeight: 700, 
                        background: rightTeamColor, 
                        color: isBrightColor(rightTeamColor) ? '#000' : '#fff' 
                      }}>{rightTeamLabel}</span>
                    </h4>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '9px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid rgba(255,255,255,0.2)' }}>
                          <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>Set</th>
                          <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>P</th>
                          <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>W</th>
                          <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>S</th>
                          <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>T</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleSets.map(set => {
                          const rightPoints = currentRightTeamKey === 'home' ? set.homePoints : set.awayPoints
                          const leftPoints = currentRightTeamKey === 'home' ? set.awayPoints : set.homePoints
                          const won = rightPoints > leftPoints ? 1 : 0
                          const substitutions = (data?.events || []).filter(e => 
                            e.type === 'substitution' && e.setIndex === set.index && e.payload?.team === currentRightTeamKey
                          ).length
                          const timeouts = (data?.events || []).filter(e => 
                            e.type === 'timeout' && e.setIndex === set.index && e.payload?.team === currentRightTeamKey
                          ).length
                          
                          // Determine row color based on set status
                          let rowColor = 'inherit'
                          if (set.finished) {
                            rowColor = won === 1 ? '#22c55e' : '#ef4444' // Green if won, red if lost
                          }
                          
                          return (
                            <tr key={set.id} style={{ 
                              borderBottom: '1px solid rgba(255,255,255,0.1)',
                              color: rowColor
                            }}>
                              <td style={{ padding: '4px 2px', textAlign: 'center' }}>{set.index}</td>
                              <td style={{ padding: '4px 2px', textAlign: 'center' }}>{rightPoints}</td>
                              <td style={{ padding: '4px 2px', textAlign: 'center' }}>{won}</td>
                              <td style={{ padding: '4px 2px', textAlign: 'center' }}>{substitutions}</td>
                              <td style={{ padding: '4px 2px', textAlign: 'center' }}>{timeouts}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              })()}
            </div>
          </div>
        </ScoreboardCourtColumn>

        <ScoreboardTeamColumn side="right">
          <div className="team-info">
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                background: rightTeam.color || '#3b82f6',
                color: isBrightColor(rightTeam.color || '#3b82f6') ? '#000' : '#fff',
                borderRadius: '6px',
                fontWeight: 600,
                fontSize: '14px',
                marginBottom: '8px'
              }}
            >
              <span>{teamBLabel}</span>
              <span>-</span>
              <span>{teamBShortName}</span>
             
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <div 
              onClick={() => {
                const timeouts = getTimeoutDetails('right')
                if (timeouts.length > 0) {
                  setToSubDetailsModal({ type: 'timeout', side: 'right' })
                }
              }}
              style={{ 
                flex: 1, 
                background: 'rgba(255, 255, 255, 0.05)', 
                borderRadius: '8px', 
                padding: '12px',
                textAlign: 'center',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                cursor: getTimeoutDetails('right').length > 0 ? 'pointer' : 'default'
              }}
            >
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>TO</div>
              <div style={{ 
                fontSize: '24px', 
                fontWeight: 700,
                color: getTimeoutsUsed('right') >= 2 ? '#ef4444' : 'inherit'
              }}>{getTimeoutsUsed('right')}</div>
            </div>
            <div 
              onClick={() => {
                const subs = getSubstitutionDetails('right')
                if (subs.length > 0) {
                  setToSubDetailsModal({ type: 'substitution', side: 'right' })
                }
              }}
              style={{ 
                flex: 1, 
                background: 'rgba(255, 255, 255, 0.05)', 
                borderRadius: '8px', 
                padding: '12px',
                textAlign: 'center',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                cursor: getSubstitutionDetails('right').length > 0 ? 'pointer' : 'default'
              }}
            >
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
            disabled={getTimeoutsUsed('right') >= 2 || rallyStatus === 'in_play' || isRallyReplayed}
            style={{ width: '100%', marginBottom: '8px' }}
          >
            Time-out
          </button>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', width: '100%' }}>
            <button 
              onClick={() => handleLiberoOut('right')}
              disabled={rallyStatus === 'in_play' || isRallyReplayed || !getLiberoOnCourt(leftIsHome ? 'away' : 'home') || !hasPointSinceLastLiberoExchange(leftIsHome ? 'away' : 'home')}
              style={{ flex: 1, fontSize: '10px', padding: '8px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              Libero out
            </button>
            <button 
              onClick={() => handleExchangeLibero('right')}
              disabled={(() => {
                const teamKey = leftIsHome ? 'away' : 'home'
                const teamPlayers = leftIsHome ? data?.awayPlayers : data?.homePlayers
                const liberos = teamPlayers?.filter(p => p.libero && p.libero !== '') || []
                const liberoOnCourt = getLiberoOnCourt(teamKey)
                
                // Check if libero on court is unable
                const liberoOnCourtUnable = liberoOnCourt && isLiberoUnable(teamKey, liberoOnCourt.liberoNumber)
                
                // Check if the other libero is unable
                const otherLibero = liberos.find(p => 
                  String(p.number) !== String(liberoOnCourt?.liberoNumber) &&
                  (liberoOnCourt?.liberoType === 'libero1' ? p.libero === 'libero2' : p.libero === 'libero1')
                )
                const otherLiberoUnable = otherLibero && isLiberoUnable(teamKey, otherLibero.number)
                
                return rallyStatus === 'in_play' || 
                       isRallyReplayed ||
                       !liberoOnCourt || 
                       !hasPointSinceLastLiberoExchange(teamKey) ||
                       liberos.length < 2 || // Disable if team has less than 2 liberos
                       liberoOnCourtUnable || // Disable if libero on court is unable
                       otherLiberoUnable // Disable if other libero is unable
              })()}
              style={{ flex: 1, fontSize: '10px', padding: '8px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              Exchange libero
            </button>
          </div>
          
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
          
          {/* Status boxes for team sanctions */}
          <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {data?.match?.sanctions?.improperRequestRight && (
              <div style={{ 
                padding: '4px 8px', 
                fontSize: '10px', 
                background: 'rgba(156, 163, 175, 0.15)', 
                border: '1px solid rgba(156, 163, 175, 0.3)',
                borderRadius: '4px',
                color: '#d1d5db'
              }}>
                Sanctioned with an improper request
              </div>
            )}
            {data?.match?.sanctions?.delayWarningRight && (
              <div style={{ 
                padding: '4px 8px', 
                fontSize: '10px', 
                background: 'rgba(234, 179, 8, 0.15)', 
                border: '1px solid rgba(234, 179, 8, 0.3)',
                borderRadius: '4px',
                color: '#facc15'
              }}>
                Sanctioned with a delay warning ⏰
              </div>
            )}
            {teamHasFormalWarning(leftIsHome ? 'away' : 'home') && (
              <div style={{ 
                padding: '4px 8px', 
                fontSize: '10px', 
                background: 'rgba(250, 204, 21, 0.15)', 
                border: '1px solid rgba(250, 204, 21, 0.3)',
                borderRadius: '4px',
                color: '#fde047'
              }}>
                Sanctioned with a formal warning 🟨
              </div>
            )}
          </div>
          
          
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
                    
                    // Find which player on court this bench player replaced (if they were substituted in)
                    const substitutionWherePlayerIn = substitutions
                      .filter(s => String(s.payload?.playerIn) === String(player.number))
                      .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0] // Get most recent
                    const playerOnCourtReplaced = substitutionWherePlayerIn?.payload?.playerOut || null
                    
                    // Check if player was substituted due to expulsion (cannot re-enter for rest of set)
                    const wasExpelledSub = wasSubstitutedDueToExpulsion(teamKey, player.number)
                    const expulsionSub = wasExpelledSub ? data.events?.find(e => 
                      e.type === 'substitution' && 
                      e.payload?.team === teamKey &&
                      String(e.payload?.playerOut) === String(player.number) &&
                      e.payload?.isExpelled === true
                    ) : null
                    const isExpelledInSet = wasExpelledSub && expulsionSub && expulsionSub.setIndex === data.set.index
                    
                    // Check if player was substituted due to disqualification (cannot re-enter for rest of game)
                    const isDisqualifiedSub = wasSubstitutedDueToDisqualification(teamKey, player.number)
                    
                    // Check if player was exceptionally substituted (cannot re-enter for rest of game)
                    const isExceptionallySub = wasExceptionallySubstituted(teamKey, player.number)
                    
                    // Also check for sanction-based expulsion/disqualification (for display)
                    const hasExpulsionSanction = data.events?.some(e => 
                      e.type === 'sanction' && 
                      e.payload?.team === teamKey &&
                      e.payload?.playerNumber === player.number &&
                      e.payload?.type === 'expulsion' &&
                      e.setIndex === data.set.index
                    )
                    const hasDisqualificationSanction = data.events?.some(e => 
                      e.type === 'sanction' && 
                      e.payload?.team === teamKey &&
                      e.payload?.playerNumber === player.number &&
                      e.payload?.type === 'disqualification'
                    )
                    
                    // Show X if substituted due to expulsion, disqualification, or exceptional substitution
                    const showX = isExpelledInSet || isDisqualifiedSub || isExceptionallySub || hasExpulsionSanction || hasDisqualificationSanction
                    
                    // Get sanctions for this player
                    const sanctions = getPlayerSanctions(teamKey, player.number)
                    const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
                    const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
                    const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
                    const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')

                    // Determine if bench player can substitute
                    // Case 1: Player was substituted out - can only come back for the player who replaced them
                    // Case 2: Player never played - can substitute for any court player (if team has subs left)
                    // BUT: If player is currently replaced by libero, they cannot substitute at all
                    const neverPlayed = !wasSubstitutedOut && !hasComeBack && !isSubstitutedByLibero
                    const canComeBackFromSub = wasSubstitutedOut && canComeBack && !hasComeBack && !isSubstitutedByLibero
                    const canSubBenchPlayer = !showX && !isSubstitutedByLibero && (canComeBackFromSub || neverPlayed)

                    // Find the court player this bench player can swap with
                    let courtPlayerToSwapWith = null
                    if (canComeBackFromSub) {
                      // Player was substituted out - can only swap with the player who replaced them
                      const subEvent = substitutions
                        .filter(s => String(s.payload?.playerOut) === String(player.number))
                        .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0]
                      if (subEvent?.payload?.playerIn && subEvent?.payload?.position) {
                        courtPlayerToSwapWith = {
                          number: subEvent.payload.playerIn,
                          position: subEvent.payload.position
                        }
                      }
                    }
                    // For neverPlayed case, courtPlayerToSwapWith stays null - we'll show expandable list

                    return (
                      <div
                        key={`${teamKey}-bench-${player.id || player.number}`}
                        onClick={(e) => {
                          if (rallyStatus === 'idle') {
                            const rect = e.currentTarget.getBoundingClientRect()
                            setBenchPlayerActionMenu({
                              team: teamKey,
                              playerNumber: player.number,
                              element: e.currentTarget,
                              x: rect.right - 8,
                              y: rect.top - 8,
                              canSubstitute: canSubBenchPlayer,
                              courtPlayerToSwapWith: courtPlayerToSwapWith,
                              neverPlayed: neverPlayed
                            })
                          }
                        }}
                        style={{
                          padding: '4px 8px',
                          background: isSubstitutedByLibero
                            ? '#ffffff'  // White for libero-replaced
                            : wasSubstitutedOut
                              ? '#fde047'  // Yellow for substituted-out
                              : (hasComeBack || showX ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.05)'),
                          borderRadius: '4px',
                          fontSize: '11px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          position: 'relative',
                          opacity: (hasComeBack || showX) ? 0.4 : 1,
                          color: (isSubstitutedByLibero || wasSubstitutedOut) ? '#000' : undefined,
                          cursor: rallyStatus === 'idle' ? 'pointer' : 'default'
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{player.number}</span>
                        {player.isCaptain && (
                          <span style={{ color: (isSubstitutedByLibero || wasSubstitutedOut) ? '#000' : 'var(--accent)', fontSize: '10px', fontWeight: 700 }}>C</span>
                        )}
                        {isSubstitutedByLibero && (
                          <span style={{
                            fontSize: '9px',
                            fontWeight: 700,
                            color: '#000',
                            background: 'rgba(0, 0, 0, 0.1)',
                            padding: '1px 3px',
                            borderRadius: '2px'
                          }}>
                            {player.substitutedByLibero.liberoType === 'libero1' ? 'L1' : 'L2'}
                          </span>
                        )}
                        {showX && (
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
                            title={
                              isDisqualifiedSub || hasDisqualificationSanction 
                                ? 'Disqualified - cannot play rest of match' 
                                : isExceptionallySub 
                                  ? 'Exceptionally substituted - cannot play rest of match'
                                  : isExpelledInSet || hasExpulsionSanction
                                    ? 'Expelled - cannot play this set'
                                    : 'Cannot re-enter'
                            }
                          >
                            ✕
                          </span>
                        )}
                        {hasComeBack && !showX && (
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
                        {(waitingForPoint || canComeBack) && !hasComeBack && !showX && (
                          <span 
                            style={{ 
                              fontSize: '7px',
                              lineHeight: '1',
                              display: 'flex',
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: '2px',
                              background: 'rgba(15, 23, 42, 0.95)',
                              padding: '1px 3px',
                              borderRadius: '2px',
                              minHeight: '12px',
                              justifyContent: 'center',
                              border: '1px solid rgba(255, 255, 255, 0.2)',
                              opacity: waitingForPoint ? 0.5 : 1
                            }}
                          >
                            <span style={{ color: '#22c55e', fontWeight: 900 }}>↑</span>
                            <span style={{ color: '#ef4444', fontWeight: 900 }}>↓</span>
                            {playerOnCourtReplaced && (
                              <span style={{ 
                                color: 'rgba(255, 255, 255, 0.8)', 
                                fontSize: '8px', 
                                fontWeight: 600,
                                marginLeft: '2px'
                              }}>
                                {playerOnCourtReplaced}
                              </span>
                            )}
                          </span>
                        )}
                        {sanctions.length > 0 && (
                          <span style={{ 
                            fontSize: '8px',
                            display: 'flex',
                            gap: '1px',
                            alignItems: 'center'
                          }}>
                            {hasExpulsion ? (
                              <div style={{ position: 'relative', width: '9px', height: '9px' }}>
                                <div className="sanction-card yellow" style={{ 
                                  width: '6px', 
                                  height: '8px',
                                  position: 'absolute',
                                  left: '0',
                                  top: '0',
                                  transform: 'rotate(-8deg)',
                                  zIndex: 1
                                }}></div>
                                <div className="sanction-card red" style={{ 
                                  width: '6px', 
                                  height: '8px',
                                  position: 'absolute',
                                  right: '0',
                                  top: '0',
                                  transform: 'rotate(8deg)',
                                  zIndex: 2
                                }}></div>
                              </div>
                            ) : (
                              <>
                                {(hasWarning || hasDisqualification) && (
                              <div className="sanction-card yellow" style={{ width: '6px', height: '8px' }}></div>
                            )}
                                {(hasPenalty || hasDisqualification) && (
                              <div className="sanction-card red" style={{ width: '6px', height: '8px' }}></div>
                                )}
                              </>
                            )}
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
                  {rightTeamBench.liberos.map(player => {
                    const teamKey = leftIsHome ? 'away' : 'home'
                    const isUnable = isLiberoUnable(teamKey, player.number)
                    
                    // Get sanctions for this libero
                    const sanctions = getPlayerSanctions(teamKey, player.number)
                    const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
                    const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
                    const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
                    const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')
                    
                    return (
                      <div 
                        key={`${teamKey}-bench-libero-${player.id || player.number}`}
                        style={{ 
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}
                      >
                        <div 
                          onClick={(e) => {
                            if (rallyStatus === 'idle' && !isUnable) {
                              // Open action menu for libero on bench
                              const rect = e.currentTarget.getBoundingClientRect()
                              setLiberoBenchActionMenu({
                                team: teamKey,
                                liberoNumber: player.number,
                                liberoType: player.libero,
                                element: e.currentTarget,
                                x: rect.right + 8,
                                y: rect.top
                              })
                            }
                          }}
                          style={{ 
                            padding: '4px 8px', 
                            background: isUnable ? 'rgba(239, 68, 68, 0.2)' : 'rgba(59, 130, 246, 0.2)', 
                            borderRadius: '4px',
                            fontSize: '11px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            border: `1px solid ${isUnable ? 'rgba(239, 68, 68, 0.3)' : 'rgba(59, 130, 246, 0.3)'}`,
                            cursor: (rallyStatus === 'idle' && !isUnable) ? 'pointer' : 'default',
                            opacity: isUnable ? 0.6 : 1
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>{player.number}</span>
                          <span style={{ color: isUnable ? '#f87171' : '#60a5fa', fontSize: '10px', fontWeight: 700 }}>
                            {player.libero === 'libero1' ? 'L1' : 'L2'}
                          </span>
                          {sanctions.length > 0 && (
                            <span style={{ display: 'flex', gap: '1px', alignItems: 'center' }}>
                              {hasExpulsion ? (
                                <div style={{ position: 'relative', width: '9px', height: '9px' }}>
                                  <div className="sanction-card yellow" style={{ 
                                    width: '5px', 
                                    height: '7px',
                                    position: 'absolute',
                                    left: '0',
                                    top: '1px',
                                    transform: 'rotate(-8deg)',
                                    zIndex: 1,
                                    borderRadius: '1px'
                                  }}></div>
                                  <div className="sanction-card red" style={{ 
                                    width: '5px', 
                                    height: '7px',
                                    position: 'absolute',
                                    right: '0',
                                    top: '1px',
                                    transform: 'rotate(8deg)',
                                    zIndex: 2,
                                    borderRadius: '1px'
                                  }}></div>
                                </div>
                              ) : (
                                <>
                                  {(hasWarning || hasDisqualification) && (
                                    <div className="sanction-card yellow" style={{ width: '6px', height: '8px', borderRadius: '1px' }}></div>
                                  )}
                                  {(hasPenalty || hasDisqualification) && (
                                    <div className="sanction-card red" style={{ width: '6px', height: '8px', borderRadius: '1px' }}></div>
                                  )}
                                </>
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            
            {/* Bench Officials */}
            {rightTeamBench.benchOfficials.length > 0 && (
              <div>
                <h4 style={{ margin: '0 0 8px', fontSize: '12px', fontWeight: 600, color: 'var(--muted)' }}>Bench Officials</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {rightTeamBench.benchOfficials.map((official, idx) => {
                    const teamKey = leftIsHome ? 'away' : 'home'
                    
                    // Get sanctions for this official
                    const sanctions = getPlayerSanctions(teamKey, null, official.role)
                    const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
                    const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
                    const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
                    const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')
                    
                    return (
                      <div 
                        key={idx} 
                        onClick={(e) => {
                          if (rallyStatus === 'idle') {
                            const rect = e.currentTarget.getBoundingClientRect()
                            setSanctionDropdown({
                              team: teamKey,
                              type: 'official',
                              role: official.role,
                              element: e.currentTarget,
                              x: rect.right - 8,
                              y: rect.top - 8
                            })
                          }
                        }}
                        style={{ 
                          padding: '4px 8px', 
                          background: 'rgba(255,255,255,0.05)', 
                          borderRadius: '4px',
                          fontSize: '11px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          cursor: rallyStatus === 'idle' ? 'pointer' : 'default'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontWeight: 600, color: 'var(--muted)', minWidth: '30px' }}>
                            {official.role === 'Coach' ? 'C' : 
                             official.role === 'Assistant Coach 1' ? 'AC1' :
                             official.role === 'Assistant Coach 2' ? 'AC2' :
                             official.role === 'Physiotherapist' ? 'P' :
                             official.role === 'Medic' ? 'M' : official.role}
                          </span>
                          <span>{official.lastName || ''} {official.firstName || ''}</span>
                          {sanctions.length > 0 && (
                            <span style={{ display: 'flex', gap: '1px', alignItems: 'center' }}>
                              {hasExpulsion ? (
                                <div style={{ position: 'relative', width: '9px', height: '9px' }}>
                                  <div className="sanction-card yellow" style={{ 
                                    width: '5px', 
                                    height: '7px',
                                    position: 'absolute',
                                    left: '0',
                                    top: '1px',
                                    transform: 'rotate(-8deg)',
                                    zIndex: 1,
                                    borderRadius: '1px'
                                  }}></div>
                                  <div className="sanction-card red" style={{ 
                                    width: '5px', 
                                    height: '7px',
                                    position: 'absolute',
                                    right: '0',
                                    top: '1px',
                                    transform: 'rotate(8deg)',
                                    zIndex: 2,
                                    borderRadius: '1px'
                                  }}></div>
                                </div>
                              ) : (
                                <>
                                  {(hasWarning || hasDisqualification) && (
                                    <div className="sanction-card yellow" style={{ width: '6px', height: '8px', borderRadius: '1px' }}></div>
                                  )}
                                  {(hasPenalty || hasDisqualification) && (
                                    <div className="sanction-card red" style={{ width: '6px', height: '8px', borderRadius: '1px' }}></div>
                                  )}
                                </>
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </ScoreboardTeamColumn>
      </div>
      )}

      {/* Menu Modal - Keep for Options submenu */}
      {menuModal && (
        <Modal
          title="Menu"
          open={true}
          onClose={() => setMenuModal(false)}
          width={400}
        >
          <div style={{ padding: '20px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '8px',
                padding: '12px 16px',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
              }}
              onClick={() => {
                setShowLogs(true)
                setMenuModal(false)
              }}>
                Show Action Log
              </div>
              <div style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '8px',
                padding: '12px 16px',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
              }}
              onClick={() => {
                setShowSanctions(true)
                setMenuModal(false)
              }}>
                Show Sanctions and Results
              </div>
              <div style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '8px',
                padding: '12px 16px',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
              }}
              onClick={() => {
                setShowManualPanel(true)
                setMenuModal(false)
              }}>
                Manual Changes
              </div>
              <div style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '8px',
                padding: '12px 16px',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
              }}
              onClick={() => {
                setShowRemarks(true)
                setMenuModal(false)
              }}>
                Open Remarks Recording
              </div>
              <div style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '8px',
                padding: '12px 16px',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
              }}
              onClick={() => {
                setShowRosters(true)
                setMenuModal(false)
              }}>
                Show Rosters
              </div>
              <div style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '8px',
                padding: '12px 16px',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
              }}
              onClick={() => {
                setShowPinsModal(true)
                setMenuModal(false)
              }}>
                Show PINs
              </div>
              {onOpenMatchSetup && (
                <div style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '8px',
                  padding: '12px 16px',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                }}
                onClick={() => {
                  onOpenMatchSetup()
                  setMenuModal(false)
                }}>
                  Show Match Setup
                </div>
              )}
           
              <div style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '8px',
                padding: '12px 16px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                marginTop: '8px',
                borderTop: '1px solid rgba(255,255,255,0.1)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
              }}
              onClick={async () => {
                try {
                  // Export all database data
                  const allMatches = await db.matches.toArray()
                  const allTeams = await db.teams.toArray()
                  const allPlayers = await db.players.toArray()
                  const allSets = await db.sets.toArray()
                  const allEvents = await db.events.toArray()
                  const allReferees = await db.referees.toArray()
                  const allScorers = await db.scorers.toArray()
                  
                  const exportData = {
                    exportDate: new Date().toISOString(),
                    matchId: matchId,
                    matches: allMatches,
                    teams: allTeams,
                    players: allPlayers,
                    sets: allSets,
                    events: allEvents,
                    referees: allReferees,
                    scorers: allScorers
                  }
                  
                  // Create a blob and download
                  const jsonString = JSON.stringify(exportData, null, 2)
                  const blob = new Blob([jsonString], { type: 'application/json' })
                  const url = URL.createObjectURL(blob)
                  const link = document.createElement('a')
                  link.href = url
                  link.download = `database_export_${matchId}_${new Date().toISOString().split('T')[0]}.json`
                  document.body.appendChild(link)
                  link.click()
                  document.body.removeChild(link)
                  URL.revokeObjectURL(url)
                  
                  setMenuModal(false)
                } catch (error) {
                  console.error('Error exporting database:', error)
                  alert('Error exporting database data. Please try again.')
                }
              }}>
                📥 Download Game Data (JSON)
              </div>
              <div style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '8px',
                padding: '12px 16px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                marginTop: '8px',
                borderTop: '1px solid rgba(255,255,255,0.1)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
              }}
              onClick={() => {
                setShowOptionsInMenu(true)
              }}>
                ⚙️ Options
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Show PINs Modal */}
      {showPinsModal && (
        <Modal
          title="Game PINs"
          open={true}
          onClose={() => setShowPinsModal(false)}
          width={500}
        >
          <div style={{ padding: '24px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Game Number and Referee PIN - Same row (50/50) */}
              {(data?.match?.gameNumber || (data?.match?.refereePin && data?.match?.refereeConnectionEnabled !== false)) && (
                <div style={{
                  display: 'flex',
                  gap: '16px',
                  width: '100%'
                }}>
                  {data?.match?.gameNumber && (
                    <div style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '8px',
                      padding: '16px',
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      minWidth: 0
                    }}>
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '4px' }}>Game Number</div>
                      <div style={{ fontSize: '20px', fontWeight: 600, fontFamily: 'monospace', letterSpacing: '2px', wordBreak: 'break-all' }}>
                        {data.match.gameNumber || data.match.game_n || 'N/A'}
                      </div>
                    </div>
                  )}
                  
                  {data?.match?.refereePin && data?.match?.refereeConnectionEnabled !== false && (
                    <div style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '8px',
                      padding: '16px',
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      minWidth: 0
                    }}>
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '4px' }}>Referee PIN</div>
                      <div style={{ fontSize: '20px', fontWeight: 600, fontFamily: 'monospace', letterSpacing: '2px', wordBreak: 'break-all' }}>
                        {String(data.match.refereePin).padStart(6, '0')}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Team PINs - Hidden for benches (only upload PINs are shown) */}
              {/* Game Upload PINs - Same row (50/50) */}
              {(data?.match?.homeTeamUploadPin || data?.match?.awayTeamUploadPin) && (
                <div style={{
                  display: 'flex',
                  gap: '16px',
                  width: '100%'
                }}>
                  {data?.match?.homeTeamUploadPin && (
                    <div style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '8px',
                      padding: '16px',
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      minWidth: 0
                    }}>
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '4px' }}>
                        {data?.homeTeam?.name || 'Home Team'} Upload PIN
                      </div>
                      <div style={{ fontSize: '20px', fontWeight: 600, fontFamily: 'monospace', letterSpacing: '2px', wordBreak: 'break-all' }}>
                        {String(data.match.homeTeamUploadPin).padStart(6, '0')}
                      </div>
                    </div>
                  )}
                  
                  {data?.match?.awayTeamUploadPin && (
                    <div style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '8px',
                      padding: '16px',
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      minWidth: 0
                    }}>
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '4px' }}>
                        {data?.awayTeam?.name || 'Away Team'} Upload PIN
                      </div>
                      <div style={{ fontSize: '20px', fontWeight: 600, fontFamily: 'monospace', letterSpacing: '2px', wordBreak: 'break-all' }}>
                        {String(data.match.awayTeamUploadPin).padStart(6, '0')}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* Captain on Court Modal */}
      {captainOnCourtModal && (
        <Modal
          title={`Select Captain on Court - ${captainOnCourtModal.team === 'home' ? (data?.homeTeam?.name || 'Home Team') : (data?.awayTeam?.name || 'Away Team')}`}
          open={true}
          onClose={handleCancelCaptainOnCourt}
          width={600}
        >
          <div style={{ padding: '24px' }}>
            <p style={{ marginBottom: '20px', fontSize: '16px' }}>
              The team captain is not on court. Please select which player is acting as captain on court:
            </p>
            
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(3, 1fr)', 
              gap: '12px',
              marginBottom: '24px'
            }}>
              {(() => {
                const team = captainOnCourtModal.team
                const teamPlayers = team === 'home' 
                  ? (data?.homePlayers || []) 
                  : (data?.awayPlayers || [])
                const teamLineupState = getTeamLineupState(team)
                const currentLineup = teamLineupState.currentLineup || {}
                
                // Get players currently on court (including liberos)
                const playersOnCourtList = []
                const positionOrder = ['I', 'II', 'III', 'IV', 'V', 'VI']
                
                positionOrder.forEach(pos => {
                  const playerNumber = currentLineup[pos]
                  if (playerNumber) {
                    const player = teamPlayers.find(p => String(p.number) === String(playerNumber))
                    if (player) {
                      playersOnCourtList.push({
                        number: player.number,
                        name: player.name || `${player.firstName || ''} ${player.lastName || ''}`.trim() || `Player ${player.number}`,
                        position: pos,
                        isLibero: !!(player.libero && player.libero !== ''),
                        isTeamCaptain: !!(player.isCaptain || player.captain)
                      })
                    }
                  }
                })
                
                return playersOnCourtList.map((player) => (
                  <button
                    key={player.number}
                    onClick={() => handleSelectCaptainOnCourt(player.number)}
                    style={{
                      padding: '16px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '2px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      textAlign: 'center'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
                    }}
                  >
                    <div style={{ fontSize: '24px', fontWeight: 700, marginBottom: '4px' }}>
                      #{player.number}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '4px' }}>
                      {player.name || 'Player'}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--muted)' }}>
                      Position {player.position}
                      {player.isLibero && ' (Libero)'}
                    </div>
                  </button>
                ))
              })()}
            </div>
            
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={handleCancelCaptainOnCourt}
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
                Cancel (No Captain)
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Options in Menu Modal */}
      {showOptionsInMenu && (
        <Modal
          title="Options"
          open={true}
          onClose={() => setShowOptionsInMenu(false)}
          width={600}
        >
          <div style={{ padding: '24px', maxHeight: '80vh', overflowY: 'auto' }}>
            {/* Server Management Section - Only show in Electron */}
            {typeof window !== 'undefined' && window.electronAPI?.server && (
            <div style={{ marginBottom: '32px', paddingBottom: '24px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <h3 style={{ marginTop: 0, marginBottom: '16px', fontSize: '18px', fontWeight: 600 }}>Live Server</h3>
              {serverRunning && serverStatus ? (
                <div>
                  <div style={{ 
                    background: 'rgba(16, 185, 129, 0.1)', 
                    border: '1px solid rgba(16, 185, 129, 0.3)', 
                    borderRadius: '8px', 
                    padding: '12px',
                    marginBottom: '12px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      <span style={{ color: '#10b981', fontWeight: 600 }}>●</span>
                      <span style={{ fontWeight: 600 }}>Server Running</span>
                    </div>
                    <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', marginLeft: '24px' }}>
                      <div>Hostname: <span style={{ fontFamily: 'monospace' }}>{serverStatus.hostname || 'escoresheet.local'}</span></div>
                      <div>IP Address: <span style={{ fontFamily: 'monospace' }}>{serverStatus.localIP}</span></div>
                      <div>Protocol: <span style={{ textTransform: 'uppercase' }}>{serverStatus.protocol || 'https'}</span></div>
                    </div>
                  </div>
                  <div style={{ 
                    background: 'rgba(15, 23, 42, 0.5)', 
                    padding: '12px', 
                    borderRadius: '8px', 
                    marginBottom: '12px',
                    fontSize: '12px'
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: '8px' }}>Connection URLs:</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontFamily: 'monospace', fontSize: '11px' }}>
                      <div style={{ wordBreak: 'break-all' }}>
                        <span style={{ color: 'rgba(255,255,255,0.6)' }}>Main: </span>
                        {serverStatus.urls?.mainIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/`}
                      </div>
                      <div style={{ wordBreak: 'break-all' }}>
                        <span style={{ color: 'rgba(255,255,255,0.6)' }}>Referee: </span>
                        {serverStatus.urls?.refereeIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/referee.html`}
                      </div>
                      <div style={{ wordBreak: 'break-all' }}>
                        <span style={{ color: 'rgba(255,255,255,0.6)' }}>Bench: </span>
                        {serverStatus.urls?.benchIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/bench.html`}
                      </div>
                      <div style={{ wordBreak: 'break-all' }}>
                        <span style={{ color: 'rgba(255,255,255,0.6)' }}>WebSocket: </span>
                        {serverStatus.urls?.websocketIP || `${serverStatus.wsProtocol}://${serverStatus.localIP}:${serverStatus.wsPort}`}
                      </div>
                    </div>
                  </div>
                  {typeof window !== 'undefined' && window.electronAPI?.server && (
                    <button
                      onClick={handleStopServer}
                      disabled={serverLoading}
                      style={{
                        padding: '10px 20px',
                        fontSize: '14px',
                        fontWeight: 600,
                        background: '#ef4444',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: serverLoading ? 'not-allowed' : 'pointer',
                        opacity: serverLoading ? 0.6 : 1,
                        width: '100%'
                      }}
                    >
                      {serverLoading ? 'Stopping...' : 'Stop Server'}
                    </button>
                  )}
                </div>
              ) : (
                <div>
                  <div style={{ 
                    background: 'rgba(239, 68, 68, 0.1)', 
                    border: '1px solid rgba(239, 68, 68, 0.3)', 
                    borderRadius: '8px', 
                    padding: '12px',
                    marginBottom: '12px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ color: '#ef4444', fontWeight: 600 }}>●</span>
                      <span>Server Not Running</span>
                    </div>
                  </div>
                  <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.7)', marginBottom: '12px' }}>
                    Start the live server to allow referee, bench, and livescore apps to connect.
                  </p>
                  {typeof window !== 'undefined' && window.electronAPI?.server ? (
                    <button
                      onClick={handleStartServer}
                      disabled={serverLoading}
                      style={{
                        padding: '10px 20px',
                        fontSize: '14px',
                        fontWeight: 600,
                        background: '#22c55e',
                        color: '#000',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: serverLoading ? 'not-allowed' : 'pointer',
                        opacity: serverLoading ? 0.6 : 1,
                        width: '100%'
                      }}
                    >
                      {serverLoading ? 'Starting...' : 'Start Server'}
                    </button>
                  ) : (
                    <div>
                      <div style={{ 
                        background: 'rgba(255, 255, 255, 0.05)', 
                        padding: '12px', 
                        borderRadius: '8px',
                        fontSize: '13px',
                        color: 'rgba(255,255,255,0.7)',
                        marginBottom: '12px'
                      }}>
                        <div style={{ marginBottom: '8px', fontWeight: 600 }}>To start the server from browser/PWA:</div>
                        <div style={{ fontFamily: 'monospace', fontSize: '12px', lineHeight: '1.6' }}>
                          1. Open terminal in the frontend directory<br/>
                          2. Run: <span style={{ color: '#22c55e', fontWeight: 600 }}>npm run start:prod</span><br/>
                          3. Or use the Electron desktop app for automatic server management
                        </div>
                      </div>
                      <button
                        onClick={async () => {
                          try {
                            const command = 'npm run start:prod'
                            await navigator.clipboard.writeText(command)
                            alert('Command copied to clipboard!')
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
                              alert('Command copied to clipboard!')
                            } catch (e) {
                              alert('Please copy manually: npm run start:prod')
                            }
                            document.body.removeChild(textArea)
                          }
                        }}
                        style={{
                          padding: '10px 20px',
                          fontSize: '14px',
                          fontWeight: 600,
                          background: 'rgba(34, 197, 94, 0.2)',
                          color: '#22c55e',
                          border: '1px solid rgba(34, 197, 94, 0.3)',
                          borderRadius: '8px',
                          cursor: 'pointer',
                          width: '100%',
                          transition: 'all 0.2s'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(34, 197, 94, 0.3)'
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'rgba(34, 197, 94, 0.2)'
                        }}
                      >
                        📋 Copy Start Command
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            )}

            {/* Other Options */}
            <div style={{ marginBottom: '24px', paddingBottom: '24px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <h3 style={{ marginTop: 0, marginBottom: '16px', fontSize: '18px', fontWeight: 600 }}>Match Options</h3>

              {/* Check Accidental Rally Start Toggle */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '8px',
                marginBottom: '12px'
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <div style={{ fontWeight: 600, fontSize: '15px' }}>Check Accidental Rally Start</div>
                    <div
                      style={{
                        position: 'relative',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: 'rgba(255, 255, 255, 0.2)',
                        color: 'rgba(255, 255, 255, 0.7)',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'help'
                      }}
                      title={`Ask for confirmation if "Start Rally" is pressed within ${accidentalRallyStartDuration}s of awarding a point`}
                    >
                      i
                    </div>
                  </div>
                  {checkAccidentalRallyStart && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                      <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>Duration:</span>
                      <input
                        type="number"
                        min="1"
                        max="10"
                        value={accidentalRallyStartDuration}
                        onChange={(e) => {
                          const val = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 3))
                          setAccidentalRallyStartDuration(val)
                          localStorage.setItem('accidentalRallyStartDuration', String(val))
                        }}
                        style={{
                          width: '50px',
                          padding: '4px 8px',
                          fontSize: '12px',
                          background: 'rgba(255,255,255,0.1)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)',
                          textAlign: 'center'
                        }}
                      />
                      <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>seconds</span>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => {
                    const newValue = !checkAccidentalRallyStart
                    setCheckAccidentalRallyStart(newValue)
                    localStorage.setItem('checkAccidentalRallyStart', String(newValue))
                  }}
                  style={{
                    width: '52px',
                    height: '28px',
                    borderRadius: '14px',
                    border: 'none',
                    cursor: 'pointer',
                    background: checkAccidentalRallyStart ? '#22c55e' : 'rgba(255, 255, 255, 0.2)',
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
                    left: checkAccidentalRallyStart ? '28px' : '4px',
                    transition: 'left 0.2s'
                  }} />
                </button>
              </div>

              {/* Check Accidental Point Award Toggle */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '8px',
                marginBottom: '12px'
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <div style={{ fontWeight: 600, fontSize: '15px' }}>Check Accidental Point Award</div>
                    <div
                      style={{
                        position: 'relative',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: 'rgba(255, 255, 255, 0.2)',
                        color: 'rgba(255, 255, 255, 0.7)',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'help'
                      }}
                      title={`Ask for confirmation if a point is awarded within ${accidentalPointAwardDuration}s of starting the rally`}
                    >
                      i
                    </div>
                  </div>
                  {checkAccidentalPointAward && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                      <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>Duration:</span>
                      <input
                        type="number"
                        min="1"
                        max="10"
                        value={accidentalPointAwardDuration}
                        onChange={(e) => {
                          const val = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 3))
                          setAccidentalPointAwardDuration(val)
                          localStorage.setItem('accidentalPointAwardDuration', String(val))
                        }}
                        style={{
                          width: '50px',
                          padding: '4px 8px',
                          fontSize: '12px',
                          background: 'rgba(255,255,255,0.1)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)',
                          textAlign: 'center'
                        }}
                      />
                      <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>seconds</span>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => {
                    const newValue = !checkAccidentalPointAward
                    setCheckAccidentalPointAward(newValue)
                    localStorage.setItem('checkAccidentalPointAward', String(newValue))
                  }}
                  style={{
                    width: '52px',
                    height: '28px',
                    borderRadius: '14px',
                    border: 'none',
                    cursor: 'pointer',
                    background: checkAccidentalPointAward ? '#22c55e' : 'rgba(255, 255, 255, 0.2)',
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
                    left: checkAccidentalPointAward ? '28px' : '4px',
                    transition: 'left 0.2s'
                  }} />
                </button>
              </div>

              {/* Manage Captain on Court Toggle */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '8px',
                marginBottom: '12px'
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <div style={{ fontWeight: 600, fontSize: '15px' }}>Manage Captain on Court</div>
                    <div
                      style={{
                        position: 'relative',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: 'rgba(255, 255, 255, 0.2)',
                        color: 'rgba(255, 255, 255, 0.7)',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'help'
                      }}
                      title="Automatically track which player acts as captain when team captain is not on court"
                    >
                      i
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => {
                    const newValue = !localManageCaptainOnCourt
                    setLocalManageCaptainOnCourt(newValue)
                    localStorage.setItem('manageCaptainOnCourt', String(newValue))
                  }}
                  style={{
                    width: '52px',
                    height: '28px',
                    borderRadius: '14px',
                    border: 'none',
                    cursor: 'pointer',
                    background: localManageCaptainOnCourt ? '#22c55e' : 'rgba(255, 255, 255, 0.2)',
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
                    left: localManageCaptainOnCourt ? '28px' : '4px',
                    transition: 'left 0.2s'
                  }} />
                </button>
              </div>

              {/* Set Interval Duration (between sets 2-3) */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '8px',
                marginBottom: '12px'
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <div style={{ fontWeight: 600, fontSize: '15px' }}>Set Interval Duration</div>
                    <div
                      style={{
                        position: 'relative',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: 'rgba(255, 255, 255, 0.2)',
                        color: 'rgba(255, 255, 255, 0.7)',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'help'
                      }}
                      title="Duration of interval between sets (default 3 minutes)"
                    >
                      i
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '16px' }}>
                  <button
                    onClick={() => {
                      const newVal = Math.max(60, setIntervalDuration - 15) // minimum 1 minute
                      setSetIntervalDuration(newVal)
                      localStorage.setItem('setIntervalDuration', String(newVal))
                    }}
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '6px',
                      border: '1px solid rgba(255,255,255,0.2)',
                      background: 'rgba(255,255,255,0.1)',
                      color: '#fff',
                      fontSize: '18px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    −
                  </button>
                  <div style={{
                    minWidth: '80px',
                    textAlign: 'center',
                    fontSize: '14px',
                    fontWeight: 600
                  }}>
                    {Math.floor(setIntervalDuration / 60)}' {String(setIntervalDuration % 60).padStart(2, '0')}''
                  </div>
                  <button
                    onClick={() => {
                      const newVal = Math.min(600, setIntervalDuration + 15) // maximum 10 minutes
                      setSetIntervalDuration(newVal)
                      localStorage.setItem('setIntervalDuration', String(newVal))
                    }}
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '6px',
                      border: '1px solid rgba(255,255,255,0.2)',
                      background: 'rgba(255,255,255,0.1)',
                      color: '#fff',
                      fontSize: '18px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Libero Exit Confirmation Toggle */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '8px',
                marginBottom: '12px'
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <div style={{ fontWeight: 600, fontSize: '15px' }}>Libero Must Exit Confirmation</div>
                    <div
                      style={{
                        position: 'relative',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: 'rgba(255, 255, 255, 0.2)',
                        color: 'rgba(255, 255, 255, 0.7)',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'help'
                      }}
                      title="Show modal when libero must exit due to rotation to front row"
                    >
                      i
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => {
                    const newValue = !liberoExitConfirmation
                    setLiberoExitConfirmation(newValue)
                    localStorage.setItem('liberoExitConfirmation', String(newValue))
                  }}
                  style={{
                    width: '52px',
                    height: '28px',
                    borderRadius: '14px',
                    border: 'none',
                    cursor: 'pointer',
                    background: liberoExitConfirmation ? '#22c55e' : 'rgba(255, 255, 255, 0.2)',
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
                    left: liberoExitConfirmation ? '28px' : '4px',
                    transition: 'left 0.2s'
                  }} />
                </button>
              </div>

              {/* Libero Entry Suggestion Toggle */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '8px',
                marginBottom: '12px'
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <div style={{ fontWeight: 600, fontSize: '15px' }}>Libero Entry Suggestion</div>
                    <div
                      style={{
                        position: 'relative',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: 'rgba(255, 255, 255, 0.2)',
                        color: 'rgba(255, 255, 255, 0.7)',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'help'
                      }}
                      title="Show suggestion modal to substitute libero for player rotating to back row"
                    >
                      i
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => {
                    const newValue = !liberoEntrySuggestion
                    setLiberoEntrySuggestion(newValue)
                    localStorage.setItem('liberoEntrySuggestion', String(newValue))
                  }}
                  style={{
                    width: '52px',
                    height: '28px',
                    borderRadius: '14px',
                    border: 'none',
                    cursor: 'pointer',
                    background: liberoEntrySuggestion ? '#22c55e' : 'rgba(255, 255, 255, 0.2)',
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
                    left: liberoEntrySuggestion ? '28px' : '4px',
                    transition: 'left 0.2s'
                  }} />
                </button>
              </div>

              {/* Keyboard Shortcuts Toggle */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '8px',
                marginBottom: '12px'
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <div style={{ fontWeight: 600, fontSize: '15px' }}>Keyboard Shortcuts</div>
                    <div
                      style={{
                        position: 'relative',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: 'rgba(255, 255, 255, 0.2)',
                        color: 'rgba(255, 255, 255, 0.7)',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'help'
                      }}
                      title="Use keyboard keys to control scoring and actions"
                    >
                      i
                    </div>
                  </div>
                  {keybindingsEnabled && (
                    <button
                      onClick={() => setKeybindingsModalOpen(true)}
                      style={{
                        marginTop: '8px',
                        padding: '6px 12px',
                        fontSize: '12px',
                        fontWeight: 600,
                        background: 'rgba(59, 130, 246, 0.2)',
                        color: '#3b82f6',
                        border: '1px solid rgba(59, 130, 246, 0.4)',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      Configure Keys
                    </button>
                  )}
                </div>
                <button
                  onClick={() => {
                    const newValue = !keybindingsEnabled
                    setKeybindingsEnabled(newValue)
                    localStorage.setItem('keybindingsEnabled', String(newValue))
                  }}
                  style={{
                    width: '52px',
                    height: '28px',
                    borderRadius: '14px',
                    border: 'none',
                    cursor: 'pointer',
                    background: keybindingsEnabled ? '#22c55e' : 'rgba(255, 255, 255, 0.2)',
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
                    left: keybindingsEnabled ? '28px' : '4px',
                    transition: 'left 0.2s'
                  }} />
                </button>
              </div>
            </div>

            {/* Display Mode Section */}
            <div style={{ marginBottom: '24px', paddingBottom: '24px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <h3 style={{ marginTop: 0, marginBottom: '16px', fontSize: '18px', fontWeight: 600 }}>Display Mode</h3>

              <div style={{
                padding: '12px 16px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '8px',
                marginBottom: '12px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                  <div style={{ fontWeight: 600, fontSize: '15px' }}>Screen Mode</div>
                  <div
                    style={{
                      position: 'relative',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '16px',
                      height: '16px',
                      borderRadius: '50%',
                      background: 'rgba(255, 255, 255, 0.2)',
                      color: 'rgba(255, 255, 255, 0.7)',
                      fontSize: '11px',
                      fontWeight: 600,
                      cursor: 'help'
                    }}
                    title="Choose a display mode optimized for your screen size. Tablet and smartphone modes will enter fullscreen and rotate to landscape."
                  >
                    i
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {['auto', 'desktop', 'tablet', 'smartphone'].map(mode => {
                    const modeDescriptions = {
                      desktop: 'Full layout with court visualization',
                      tablet: 'Scaled-down layout optimized for 768-1024px screens',
                      smartphone: 'Compact 3-column layout without court, optimized for <768px screens'
                    }
                    return (
                      <button
                        key={mode}
                        onClick={() => {
                          if (mode === 'tablet' || mode === 'smartphone') {
                            enterDisplayMode(mode)
                          } else {
                            if (mode === 'desktop') {
                              exitDisplayMode()
                            } else {
                              setDisplayMode(mode)
                              localStorage.setItem('displayMode', mode)
                            }
                          }
                        }}
                        style={{
                          padding: '8px 16px',
                          fontSize: '13px',
                          fontWeight: 600,
                          background: displayMode === mode ? '#3b82f6' : 'rgba(255, 255, 255, 0.1)',
                          color: displayMode === mode ? '#fff' : 'var(--text)',
                          border: displayMode === mode ? '1px solid #3b82f6' : '1px solid rgba(255, 255, 255, 0.2)',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          textTransform: 'capitalize',
                          transition: 'all 0.2s',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px'
                        }}
                      >
                        <span>{mode === 'auto' ? `Auto (${detectedDisplayMode})` : mode}</span>
                        {modeDescriptions[mode] && (
                          <div
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '14px',
                              height: '14px',
                              borderRadius: '50%',
                              background: displayMode === mode ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.2)',
                              color: displayMode === mode ? '#fff' : 'rgba(255, 255, 255, 0.7)',
                              fontSize: '10px',
                              fontWeight: 600,
                              cursor: 'help'
                            }}
                            title={modeDescriptions[mode]}
                            onClick={(e) => e.stopPropagation()}
                          >
                            i
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
                {displayMode !== 'desktop' && displayMode !== 'auto' && (
                  <div style={{ marginTop: '12px' }}>
                    <button
                      onClick={exitDisplayMode}
                      style={{
                        padding: '6px 12px',
                        fontSize: '12px',
                        fontWeight: 600,
                        background: 'rgba(239, 68, 68, 0.2)',
                        color: '#ef4444',
                        border: '1px solid rgba(239, 68, 68, 0.4)',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      Exit {displayMode} mode
                    </button>
                  </div>
                )}
              </div>

            </div>

            <div style={{ marginBottom: '24px' }}>
              <button
                onClick={() => {
                  setShowOptionsInMenu(false)
                  setScoreboardGuideModal(true)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px 16px',
                  fontSize: '16px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  width: '100%',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                }}
              >
                <span style={{ fontSize: '20px' }}>?</span>
                <span>Show Guide</span>
              </button>
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '24px' }}>
              <button
                onClick={() => setShowOptionsInMenu(false)}
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
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Scoreboard Guide Modal */}
      <GuideModal
        open={scoreboardGuideModal}
        onClose={() => setScoreboardGuideModal(false)}
      />

      {/* Help & Video Guides Modal */}
      {showHelpModal && (
        <Modal
          title="Help & Video Guides"
          open={true}
          onClose={() => {
            setShowHelpModal(false)
            setSelectedHelpTopic(null)
          }}
          width={800}
        >
          <div style={{ padding: '24px' }}>
            {!selectedHelpTopic ? (
              <div>
                <p style={{ marginBottom: '24px', fontSize: '16px', color: 'var(--muted)' }}>
                  Select a topic to view video guides and explanations:
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '12px' }}>
                  {[
                    { id: 'recording-points', title: 'Recording Points', description: 'How to record points and update the score' },
                    { id: 'timeouts', title: 'Timeouts', description: 'How to request and manage timeouts' },
                    { id: 'substitutions', title: 'Substitutions', description: 'How to make player substitutions' },
                    { id: 'libero', title: 'Libero Substitutions', description: 'How to handle libero exchanges' },
                    { id: 'sanctions', title: 'Sanctions', description: 'How to record warnings, penalties, and expulsions' },
                    { id: 'ending-set', title: 'Ending a Set', description: 'What happens when you end a set' },
                    { id: 'match-end', title: 'Match End', description: 'What happens when the match ends' },
                    { id: 'undo', title: 'Undo Actions', description: 'How to undo mistakes' },
                    { id: 'lineup', title: 'Setting Lineup', description: 'How to set initial lineup' },
                    { id: 'set-5', title: 'Set 5 (Tie-break)', description: 'Special rules for the deciding set' }
                  ].map((topic) => (
                    <div
                      key={topic.id}
                      onClick={() => setSelectedHelpTopic(topic.id)}
                      style={{
                        background: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '8px',
                        padding: '16px',
                        cursor: 'pointer',
                        transition: 'all 0.2s'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
                        e.currentTarget.style.transform = 'translateY(-2px)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                        e.currentTarget.style.transform = 'translateY(0)'
                      }}
                    >
                      <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
                        {topic.title}
                      </div>
                      <div style={{ fontSize: '14px', color: 'var(--muted)' }}>
                        {topic.description}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div>
                <button
                  onClick={() => setSelectedHelpTopic(null)}
                  style={{
                    marginBottom: '20px',
                    padding: '8px 16px',
                    background: 'rgba(255, 255, 255, 0.1)',
                    color: 'var(--text)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '14px'
                  }}
                >
                  ← Back to Topics
                </button>
                {getHelpContent(selectedHelpTopic)}
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Action Log Modal */}
      {showLogs && (
        <Modal
          title="Action Log"
          open={true}
          onClose={() => setShowLogs(false)}
          width={1200}
        >
          <div style={{ padding: '20px', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ marginBottom: '16px' }}>
              <input
                type="text"
                placeholder="Search events..."
                value={logSearchQuery}
                onChange={(e) => setLogSearchQuery(e.target.value)}
                style={{
                  padding: '8px 12px',
                  fontSize: '14px',
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '6px',
                  color: 'var(--text)',
                  width: '100%'
                }}
              />
            </div>
            {(() => {
              if (!data?.events || data.events.length === 0) {
                return <p>No events recorded yet.</p>
              }
              
              // Helper function to get set number (before set 1 is set 1, between sets is the next set)
              const getSetNumber = (event) => {
                const eventSetIndex = event.setIndex || 1
                if (eventSetIndex >= 1) return eventSetIndex
                // If setIndex is 0 or undefined, check if we're before set 1
                const allSets = data.sets || []
                const firstSet = allSets.find(s => s.index === 1)
                if (!firstSet) return 1
                // Check if event is before first set start
                const eventTime = typeof event.ts === 'number' ? event.ts : new Date(event.ts).getTime()
                const firstSetStart = firstSet.startTime ? new Date(firstSet.startTime).getTime() : 0
                if (eventTime < firstSetStart) return 1
                // Between sets - find the next set
                const sortedSets = [...allSets].sort((a, b) => a.index - b.index)
                for (let i = 0; i < sortedSets.length - 1; i++) {
                  const currentSet = sortedSets[i]
                  const nextSet = sortedSets[i + 1]
                  const currentEnd = currentSet.endTime ? new Date(currentSet.endTime).getTime() : 0
                  const nextStart = nextSet.startTime ? new Date(nextSet.startTime).getTime() : Infinity
                  if (eventTime >= currentEnd && eventTime < nextStart) {
                    return nextSet.index
                  }
                }
                return eventSetIndex || 1
              }
              
              // Helper function to get score at time of event
              const getScoreAtEvent = (event) => {
                const setIdx = event.setIndex || 1
                const setEvents = data.events?.filter(e => (e.setIndex || 1) === setIdx) || []
                const eventIndex = setEvents.findIndex(e => e.id === event.id)
                
                let homeScore = 0
                let awayScore = 0
                // Count points up to and including this event
                for (let i = 0; i <= eventIndex; i++) {
                  const e = setEvents[i]
                  if (e.type === 'point') {
                    if (e.payload?.team === 'home') homeScore++
                    else if (e.payload?.team === 'away') awayScore++
                  }
                }
                
                const team = event.payload?.team
                if (team === 'home') {
                  // Team A (home) score : Team B (away) score
                  return `${homeScore}:${awayScore}`
                } else if (team === 'away') {
                  // Team B (away) score : Team A (home) score
                  return `${awayScore}:${homeScore}`
                }
                // For non-team events, show home:away
                return `${homeScore}:${awayScore}`
              }
              
              // Helper function to get team label
              const getTeamLabel = (event) => {
                const team = event.payload?.team
                if (team === 'home' || team === 'away') {
                  const teamKey = team === 'home' ? teamAKey : teamBKey
                  return teamKey === teamAKey ? 'A' : 'B'
                }
                if (event.type === 'set_start' || event.type === 'set_end' || event.type === 'rally_start' || event.type === 'replay') {
                  return 'GAME'
                }
                if (event.type === 'remark') {
                  return 'GAME'
                }
                if (event.type === 'sanction' && event.payload?.role) {
                  return 'REF'
                }
                return 'GAME'
              }
              
              // Helper function to get participant
              const getParticipant = (event) => {
                const team = event.payload?.team
                const playerNumber = event.payload?.playerNumber
                const role = event.payload?.role
                const playerType = event.payload?.playerType
                
                if (event.type === 'set_start' || event.type === 'set_end' || event.type === 'rally_start' || event.type === 'replay') {
                  return 'GAME'
                }
                
                if (event.type === 'remark') {
                  return 'GAME'
                }
                
                // Sanction events with role (bench official)
                if (role) {
                  if (role === 'Coach') return 'C'
                  if (role === 'Assistant Coach 1') return 'AC1'
                  if (role === 'Assistant Coach 2') return 'AC2'
                  if (role === 'Physiotherapist') return 'P'
                  if (role === 'Medic') return 'M'
                  return role
                }
                
                // Sanction events with player number
                if (playerNumber !== undefined && playerNumber !== null) {
                  return String(playerNumber)
                }
                
                // For substitution events
                if (event.type === 'substitution') {
                  const playerOut = event.payload?.playerOut
                  const playerIn = event.payload?.playerIn
                  if (playerOut !== undefined && playerOut !== null) {
                    return `OUT:${playerOut}${playerIn !== undefined && playerIn !== null ? ` IN:${playerIn}` : ''}`
                  }
                  // Fall through to team
                }
                
                // For libero events
                if (event.type === 'libero_entry') {
                  const liberoIn = event.payload?.liberoIn
                  const playerOut = event.payload?.playerOut
                  if (liberoIn) return `L${event.payload?.liberoType === 'libero2' ? '2' : '1'} ${liberoIn}${playerOut ? ` (for ${playerOut})` : ''}`
                }
                if (event.type === 'libero_exit') {
                  const liberoOut = event.payload?.liberoOut
                  const playerIn = event.payload?.playerIn
                  if (liberoOut) return `L${event.payload?.liberoType === 'libero2' ? '2' : '1'} ${liberoOut}${playerIn ? ` (${playerIn} in)` : ''}`
                }
                if (event.type === 'libero_substitution') {
                  const liberoOut = event.payload?.liberoOut
                  const liberoIn = event.payload?.liberoIn
                  if (liberoOut && liberoIn) {
                    return `L${event.payload?.liberoOutType === 'libero2' ? '2' : '1'} ${liberoOut} ↔ L${event.payload?.liberoInType === 'libero2' ? '2' : '1'} ${liberoIn}`
                  }
                }
                if (event.type === 'libero_unable') {
                  const liberoNumber = event.payload?.liberoNumber
                  if (liberoNumber) return `L${event.payload?.liberoType === 'libero2' ? '2' : '1'} ${liberoNumber}`
                }
                
                // Default to team
                if (team === 'home' || team === 'away') {
                  const teamKey = team === 'home' ? teamAKey : teamBKey
                  return teamKey === teamAKey ? 'A' : 'B'
                }
                
                return 'GAME'
              }
              
              // Sort events by seq descending (most recent first)
              const sortedEvents = [...data.events].sort((a, b) => {
                const aSeq = a.seq || 0
                const bSeq = b.seq || 0
                if (aSeq !== 0 || bSeq !== 0) {
                  return bSeq - aSeq // Descending
                }
                const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
                const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
                return bTime - aTime // Descending
              })
              
              // Filter events
              const filteredEvents = sortedEvents.filter(event => {
                if (logSearchQuery.trim() === '') return true
                const searchLower = logSearchQuery.toLowerCase()
                const eventDescription = getActionDescription(event) || ''
                const descriptionLower = eventDescription.toLowerCase()
                const setIndex = String(getSetNumber(event))
                const teamLabel = getTeamLabel(event)
                const participant = getParticipant(event)
                return descriptionLower.includes(searchLower) || 
                       setIndex.includes(searchLower) ||
                       teamLabel.toLowerCase().includes(searchLower) ||
                       participant.toLowerCase().includes(searchLower)
              })
              
              return (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ 
                    width: '100%', 
                    borderCollapse: 'collapse',
                    fontSize: '12px'
                  }}>
                    <thead>
                      <tr style={{ 
                        borderBottom: '2px solid rgba(255,255,255,0.2)',
                        background: 'rgba(255,255,255,0.05)'
                      }}>
                        <th style={{ 
                          padding: '10px 8px', 
                          textAlign: 'left', 
                          fontWeight: 600,
                          minWidth: '80px'
                        }}>Action ID</th>
                        <th style={{ 
                          padding: '10px 8px', 
                          textAlign: 'left', 
                          fontWeight: 600,
                          minWidth: '100px'
                        }}>Time</th>
                        <th style={{ 
                          padding: '10px 8px', 
                          textAlign: 'center', 
                          fontWeight: 600,
                          minWidth: '60px'
                        }}>Set</th>
                        <th style={{ 
                          padding: '10px 8px', 
                          textAlign: 'center', 
                          fontWeight: 600,
                          minWidth: '80px'
                        }}>Score</th>
                        <th style={{ 
                          padding: '10px 8px', 
                          textAlign: 'center', 
                          fontWeight: 600,
                          minWidth: '60px'
                        }}>Team</th>
                        <th style={{ 
                          padding: '10px 8px', 
                          textAlign: 'left', 
                          fontWeight: 600,
                          minWidth: '100px'
                        }}>Participant</th>
                        <th style={{ 
                          padding: '10px 8px', 
                          textAlign: 'left', 
                          fontWeight: 600
                        }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEvents.length === 0 ? (
                        <tr>
                          <td colSpan="7" style={{ padding: '20px', textAlign: 'center', color: 'var(--muted)' }}>
                            No events found
                          </td>
                        </tr>
                      ) : (
                        filteredEvents
                          .filter(event => {
                            // Filter out sub-events (decimals) - only show main actions (integers)
                            const seq = event.seq || 0
                            return seq === Math.floor(seq) // Only show if it's an integer (no decimal part)
                          })
                          .map(event => {
                          const eventDescription = getActionDescription(event)
                          if (!eventDescription || eventDescription === 'Unknown action') return null
                          
                          const actionId = Math.floor(event.seq || 0) // Show only base integer ID
                          const eventTime = typeof event.ts === 'number' ? new Date(event.ts) : new Date(event.ts)
                          const timeStr = eventTime.toLocaleTimeString(undefined, { 
                            hour: '2-digit', 
                            minute: '2-digit', 
                            second: '2-digit', 
                            hour12: false 
                          })
                          const setNum = getSetNumber(event)
                          const score = getScoreAtEvent(event)
                          const team = getTeamLabel(event)
                          const participant = getParticipant(event)
                          
                          return (
                            <tr 
                              key={event.id} 
                              style={{ 
                                borderBottom: '1px solid rgba(255,255,255,0.1)',
                                transition: 'background 0.2s'
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'transparent'
                              }}
                            >
                              <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: '11px' }}>
                                {actionId}
                              </td>
                              <td style={{ padding: '8px' }}>
                                {timeStr}
                              </td>
                              <td style={{ padding: '8px', textAlign: 'center' }}>
                                {setNum}
                              </td>
                              <td style={{ padding: '8px', textAlign: 'center', fontFamily: 'monospace' }}>
                                {score}
                              </td>
                              <td style={{ padding: '8px', textAlign: 'center', fontWeight: 600 }}>
                                {team}
                              </td>
                              <td style={{ padding: '8px' }}>
                                {participant}
                              </td>
                              <td style={{ padding: '8px' }}>
                                {eventDescription}
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              )
            })()}
          </div>
        </Modal>
      )}

      {/* Manual Changes Modal */}
      {showManualPanel && (
        <Modal
          title="Manual Changes"
          open={true}
          onClose={() => setShowManualPanel(false)}
          width={600}
        >
          <div style={{ padding: '20px', maxHeight: '80vh', overflowY: 'auto' }}>
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
                
                {/* Reopen completed sets */}
                {data?.sets && (() => {
                  // Filter out the current set - only show finished sets that are not the current set
                  const currentSetIndex = data?.set?.index
                  const completedSets = data.sets
                    .filter(s => s.finished && s.index !== currentSetIndex)
                    .sort((a, b) => b.index - a.index)
                  if (completedSets.length === 0) return null
                  
                  return (
                    <div
                      className="manual-item"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        paddingTop: '16px'
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: '8px' }}>Reopen completed sets</div>
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                        Reopen a completed set to make corrections.
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {completedSets.map(set => (
                          <button
                            key={set.id}
                            className="secondary"
                            onClick={() => setReopenSetConfirm({ setId: set.id, setIndex: set.index })}
                            style={{ textAlign: 'left', padding: '10px 16px' }}
                          >
                            Reopen Set {set.index} ({set.homePoints} - {set.awayPoints})
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })()}
                
                {/* Manual Score Editing */}
                {data?.set && (
                  <div
                    className="manual-item"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      paddingTop: '16px',
                      borderTop: '1px solid rgba(255,255,255,0.08)'
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: '8px' }}>Edit Current Set Score</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                      Manually adjust the score for the current set.
                    </div>
                    <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <label style={{ fontSize: '12px', minWidth: '60px' }}>
                          {leftIsHome ? 'Home' : 'Away'}:
                        </label>
                        <input
                          type="number"
                          min="0"
                          max="99"
                          value={data.set.homePoints || 0}
                          onChange={async (e) => {
                            const newPoints = Math.max(0, Math.min(99, parseInt(e.target.value) || 0))
                            await db.sets.update(data.set.id, { homePoints: newPoints })
                          }}
                          style={{
                            width: '60px',
                            padding: '6px 8px',
                            fontSize: '14px',
                            background: 'var(--bg-secondary)',
                            border: '1px solid rgba(255,255,255,0.2)',
                            borderRadius: '4px',
                            color: 'var(--text)'
                          }}
                        />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <label style={{ fontSize: '12px', minWidth: '60px' }}>
                          {leftIsHome ? 'Away' : 'Home'}:
                        </label>
                        <input
                          type="number"
                          min="0"
                          max="99"
                          value={data.set.awayPoints || 0}
                          onChange={async (e) => {
                            const newPoints = Math.max(0, Math.min(99, parseInt(e.target.value) || 0))
                            await db.sets.update(data.set.id, { awayPoints: newPoints })
                          }}
                          style={{
                            width: '60px',
                            padding: '6px 8px',
                            fontSize: '14px',
                            background: 'var(--bg-secondary)',
                            border: '1px solid rgba(255,255,255,0.2)',
                            borderRadius: '4px',
                            color: 'var(--text)'
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Edit All Sets */}
                {data?.sets && data.sets.length > 0 && (
                  <div
                    className="manual-item"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      paddingTop: '16px',
                      borderTop: '1px solid rgba(255,255,255,0.08)'
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: '8px' }}>Edit All Sets</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                      Manually adjust scores for any set.
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {data.sets.sort((a, b) => a.index - b.index).map(set => (
                        <div key={set.id} style={{ 
                          display: 'flex', 
                          alignItems: 'center', 
                          gap: '12px',
                          padding: '8px',
                          background: 'rgba(255,255,255,0.03)',
                          borderRadius: '6px'
                        }}>
                          <div style={{ fontWeight: 600, minWidth: '60px' }}>Set {set.index}:</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <label style={{ fontSize: '11px' }}>Home:</label>
                            <input
                              type="number"
                              min="0"
                              max="99"
                              value={set.homePoints || 0}
                              onChange={async (e) => {
                                const newPoints = Math.max(0, Math.min(99, parseInt(e.target.value) || 0))
                                await db.sets.update(set.id, { homePoints: newPoints })
                              }}
                              style={{
                                width: '50px',
                                padding: '4px 6px',
                                fontSize: '12px',
                                background: 'var(--bg-secondary)',
                                border: '1px solid rgba(255,255,255,0.2)',
                                borderRadius: '4px',
                                color: 'var(--text)'
                              }}
                            />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <label style={{ fontSize: '11px' }}>Away:</label>
                            <input
                              type="number"
                              min="0"
                              max="99"
                              value={set.awayPoints || 0}
                              onChange={async (e) => {
                                const newPoints = Math.max(0, Math.min(99, parseInt(e.target.value) || 0))
                                await db.sets.update(set.id, { awayPoints: newPoints })
                              }}
                              style={{
                                width: '50px',
                                padding: '4px 6px',
                                fontSize: '12px',
                                background: 'var(--bg-secondary)',
                                border: '1px solid rgba(255,255,255,0.2)',
                                borderRadius: '4px',
                                color: 'var(--text)'
                              }}
                            />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
                            <label style={{ fontSize: '11px' }}>Finished:</label>
                            <input
                              type="checkbox"
                              checked={set.finished || false}
                              onChange={async (e) => {
                                await db.sets.update(set.id, { finished: e.target.checked })
                              }}
                              style={{
                                width: '18px',
                                height: '18px',
                                cursor: 'pointer'
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Edit Coin Toss */}
                {data?.match && (
                  <div
                    className="manual-item"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      paddingTop: '16px',
                      borderTop: '1px solid rgba(255,255,255,0.08)'
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: '8px' }}>Edit Coin Toss</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                      Manually adjust coin toss results (Team A, Team B, and first serve).
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <label style={{ fontSize: '12px', minWidth: '120px' }}>Team A:</label>
                        <select
                          value={data.match.coinTossTeamA || 'home'}
                          onChange={async (e) => {
                            await db.matches.update(matchId, { coinTossTeamA: e.target.value })
                          }}
                          style={{
                            flex: 1,
                            padding: '6px 8px',
                            fontSize: '12px',
                            background: '#1e293b',
                            border: '1px solid rgba(255,255,255,0.2)',
                            borderRadius: '4px',
                            color: 'var(--text)'
                          }}
                        >
                          <option value="home" style={{ background: '#1e293b', color: 'var(--text)' }}>Home</option>
                          <option value="away" style={{ background: '#1e293b', color: 'var(--text)' }}>Away</option>
                        </select>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <label style={{ fontSize: '12px', minWidth: '120px' }}>Team B:</label>
                        <select
                          value={data.match.coinTossTeamB || 'away'}
                          onChange={async (e) => {
                            await db.matches.update(matchId, { coinTossTeamB: e.target.value })
                          }}
                          style={{
                            flex: 1,
                            padding: '6px 8px',
                            fontSize: '12px',
                            background: '#1e293b',
                            border: '1px solid rgba(255,255,255,0.2)',
                            borderRadius: '4px',
                            color: 'var(--text)'
                          }}
                        >
                          <option value="home" style={{ background: '#1e293b', color: 'var(--text)' }}>Home</option>
                          <option value="away" style={{ background: '#1e293b', color: 'var(--text)' }}>Away</option>
                        </select>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <label style={{ fontSize: '12px', minWidth: '120px' }}>First Serve:</label>
                        <select
                          value={data.match.firstServe || 'home'}
                          onChange={async (e) => {
                            await db.matches.update(matchId, { firstServe: e.target.value })
                          }}
                          style={{
                            flex: 1,
                            padding: '6px 8px',
                            fontSize: '12px',
                            background: '#1e293b',
                            border: '1px solid rgba(255,255,255,0.2)',
                            borderRadius: '4px',
                            color: 'var(--text)'
                          }}
                        >
                          <option value="home" style={{ background: '#1e293b', color: 'var(--text)' }}>Home</option>
                          <option value="away" style={{ background: '#1e293b', color: 'var(--text)' }}>Away</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Edit Match Information */}
                {data?.match && (
                  <div
                    className="manual-item"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      paddingTop: '16px',
                      borderTop: '1px solid rgba(255,255,255,0.08)'
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: '8px' }}>Edit Match Information</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                      Manually adjust match status and settings.
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <label style={{ fontSize: '12px', minWidth: '120px' }}>Match Status:</label>
                        <select
                          value={data.match.status || 'live'}
                          onChange={async (e) => {
                            await db.matches.update(matchId, { status: e.target.value })
                          }}
                          style={{
                            flex: 1,
                            padding: '6px 8px',
                            fontSize: '12px',
                            background: '#1e293b',
                            border: '1px solid rgba(255,255,255,0.2)',
                            borderRadius: '4px',
                            color: 'var(--text)'
                          }}
                        >
                          <option value="live" style={{ background: '#1e293b', color: 'var(--text)' }}>Live</option>
                          <option value="final" style={{ background: '#1e293b', color: 'var(--text)' }}>Final</option>
                          <option value="paused" style={{ background: '#1e293b', color: 'var(--text)' }}>Paused</option>
                        </select>
                      </div>
                      {data?.set?.index === 5 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <label style={{ fontSize: '12px', minWidth: '120px' }}>Set 5 First Serve:</label>
                          <select
                            value={data.match.set5FirstServe || 'A'}
                            onChange={async (e) => {
                              await db.matches.update(matchId, { set5FirstServe: e.target.value })
                            }}
                            style={{
                              flex: 1,
                              padding: '6px 8px',
                              fontSize: '12px',
                              background: '#1e293b',
                              border: '1px solid rgba(255,255,255,0.2)',
                              borderRadius: '4px',
                              color: 'var(--text)'
                            }}
                          >
                            <option value="A" style={{ background: '#1e293b', color: 'var(--text)' }}>Team A</option>
                            <option value="B" style={{ background: '#1e293b', color: 'var(--text)' }}>Team B</option>
                          </select>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Switch Sides and Serve */}
                {data?.set && data?.match && (
                  <div
                    className="manual-item"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      paddingTop: '16px',
                      borderTop: '1px solid rgba(255,255,255,0.08)'
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: '8px' }}>Switch Sides and Serve</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                      Manually switch which team is on which side or which team serves.
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--muted)' }}>Switch Sides:</div>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                          {data.set.index === 5 ? (
                            <>
                              <button
                                className="secondary"
                                onClick={async () => {
                                  const currentLeftTeam = data.match.set5LeftTeam || (teamAKey === 'home' ? 'A' : 'B')
                                  const newLeftTeam = currentLeftTeam === 'A' ? 'B' : 'A'
                                  await db.matches.update(matchId, { set5LeftTeam: newLeftTeam })
                                }}
                                style={{
                                  padding: '8px 16px',
                                  fontSize: '12px'
                                }}
                              >
                                Switch Sides (Set 5)
                              </button>
                              <button
                                className="secondary"
                                onClick={async () => {
                                  await db.matches.update(matchId, { 
                                    set5CourtSwitched: !data.match.set5CourtSwitched 
                                  })
                                }}
                                style={{
                                  padding: '8px 16px',
                                  fontSize: '12px'
                                }}
                              >
                                Toggle Court Switch Flag
                              </button>
                            </>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
                              <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>
                                Override automatic side switching for Sets 1-4:
                              </div>
                              {[1, 2, 3, 4].map(setNum => {
                                const overrides = data.match?.setLeftTeamOverrides || {}
                                const currentOverride = overrides[setNum]
                                // Calculate automatic: odd sets (1,3) = A, even sets (2,4) = B
                                const automatic = setNum % 2 === 1 ? 'A' : 'B'
                                const currentValue = currentOverride || automatic
                                
                                return (
                                  <div key={setNum} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <label style={{ fontSize: '11px', minWidth: '60px' }}>Set {setNum}:</label>
                                    <select
                                      value={currentValue}
                                      onChange={async (e) => {
                                        const newValue = e.target.value
                                        const currentOverrides = data.match?.setLeftTeamOverrides || {}
                                        
                                        if (newValue === automatic) {
                                          // Remove override if set back to automatic
                                          const newOverrides = { ...currentOverrides }
                                          delete newOverrides[setNum]
                                          await db.matches.update(matchId, { 
                                            setLeftTeamOverrides: Object.keys(newOverrides).length > 0 ? newOverrides : null
                                          })
                                        } else {
                                          // Set manual override
                                          await db.matches.update(matchId, { 
                                            setLeftTeamOverrides: { ...currentOverrides, [setNum]: newValue }
                                          })
                                        }
                                      }}
                                      style={{
                                        flex: 1,
                                        padding: '6px 8px',
                                        fontSize: '11px',
                                        background: '#1e293b',
                                        border: '1px solid rgba(255,255,255,0.2)',
                                        borderRadius: '4px',
                                        color: 'var(--text)',
                                        maxWidth: '120px'
                                      }}
                                    >
                                      <option value="A" style={{ background: '#1e293b', color: 'var(--text)' }}>Team A (Left)</option>
                                      <option value="B" style={{ background: '#1e293b', color: 'var(--text)' }}>Team B (Left)</option>
                                    </select>
                                    {currentOverride && (
                                      <span style={{ fontSize: '10px', color: 'var(--muted)' }}>(Override)</span>
                                    )}
                                    {!currentOverride && (
                                      <span style={{ fontSize: '10px', color: 'var(--muted)' }}>(Auto)</span>
                                    )}
                                  </div>
                                )
                              })}
                              {data.match?.setLeftTeamOverrides && Object.keys(data.match.setLeftTeamOverrides).length > 0 && (
                                <button
                                  className="secondary"
                                  onClick={async () => {
                                    await db.matches.update(matchId, { setLeftTeamOverrides: null })
                                  }}
                                  style={{
                                    padding: '6px 12px',
                                    fontSize: '11px',
                                    marginTop: '4px'
                                  }}
                                >
                                  Clear All Overrides (Use Automatic)
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--muted)' }}>Switch Serve:</div>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                          <button
                            className="secondary"
                            onClick={async () => {
                              const currentServe = data.set.index === 5 && data.match.set5FirstServe
                                ? (data.match.set5FirstServe === 'A' ? teamAKey : teamBKey)
                                : (data.match.firstServe || 'home')
                              const newServe = currentServe === 'home' ? 'away' : 'home'
                              
                              if (data.set.index === 5) {
                                const newSet5FirstServe = newServe === teamAKey ? 'A' : 'B'
                                await db.matches.update(matchId, { set5FirstServe: newSet5FirstServe })
                              } else {
                                await db.matches.update(matchId, { firstServe: newServe })
                              }
                            }}
                            style={{
                              padding: '8px 16px',
                              fontSize: '12px'
                            }}
                          >
                            Switch Current Serve
                          </button>
                          {data.set.index === 5 && (
                            <button
                              className="secondary"
                              onClick={async () => {
                                const currentSet5Serve = data.match.set5FirstServe || 'A'
                                const newSet5Serve = currentSet5Serve === 'A' ? 'B' : 'A'
                                await db.matches.update(matchId, { set5FirstServe: newSet5Serve })
                              }}
                              style={{
                                padding: '8px 16px',
                                fontSize: '12px'
                              }}
                            >
                              Switch Set 5 First Serve (A/B)
                            </button>
                          )}
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--muted)', marginTop: '4px' }}>
                          Current serve: {(() => {
                            if (data.set.index === 5 && data.match.set5FirstServe) {
                              return `Set 5: Team ${data.match.set5FirstServe}`
                            }
                            const serveTeam = data.match.firstServe || 'home'
                            return `Sets 1-4: ${serveTeam === 'home' ? 'Home' : 'Away'}`
                          })()}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Edit Points */}
                {data?.events && (() => {
                  const pointEvents = data.events.filter(e => e.type === 'point').sort((a, b) => (b.seq || 0) - (a.seq || 0)).slice(0, 20)
                  if (pointEvents.length === 0) return null
                  
                  return (
                    <div
                      className="manual-item"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        paddingTop: '16px',
                        borderTop: '1px solid rgba(255,255,255,0.08)'
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: '8px' }}>Edit Points ({pointEvents.length} most recent)</div>
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                        Edit or delete point events. Score shown is at time of point.
                      </div>
                      <div style={{ 
                        maxHeight: '300px', 
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px'
                      }}>
                        {pointEvents.map(event => {
                          const setIndex = event.setIndex || 1
                          const team = event.payload?.team
                          const teamLabel = team === teamAKey ? 'A' : (team === teamBKey ? 'B' : '')
                          
                          // Calculate score at time of this point
                          const setEvents = data.events.filter(e => e.setIndex === setIndex)
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
                          
                          return (
                            <div key={event.id} style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              padding: '8px',
                              background: 'rgba(255,255,255,0.03)',
                              borderRadius: '4px',
                              fontSize: '11px'
                            }}>
                              <span style={{ minWidth: '60px' }}>Set {setIndex}</span>
                              <select
                                value={team || 'home'}
                                onChange={async (e) => {
                                  await db.events.update(event.id, {
                                    payload: { ...event.payload, team: e.target.value }
                                  })
                                }}
                                style={{
                                  padding: '4px 6px',
                                  fontSize: '11px',
                                  background: '#1e293b',
                                  border: '1px solid rgba(255,255,255,0.2)',
                                  borderRadius: '4px',
                                  color: 'var(--text)',
                                  minWidth: '80px'
                                }}
                              >
                                <option value="home" style={{ background: '#1e293b', color: 'var(--text)' }}>Home</option>
                                <option value="away" style={{ background: '#1e293b', color: 'var(--text)' }}>Away</option>
                              </select>
                              <span style={{ minWidth: '50px' }}>Score: {homeScore}-{awayScore}</span>
                              <button
                                className="danger"
                                onClick={async () => {
                                  if (confirm(`Delete this point event?`)) {
                                    await db.events.delete(event.id)
                                  }
                                }}
                                style={{
                                  padding: '4px 8px',
                                  fontSize: '10px',
                                  marginLeft: 'auto'
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
                
                {/* Edit Timeouts */}
                {data?.events && (() => {
                  const timeoutEvents = data.events.filter(e => e.type === 'timeout').sort((a, b) => (b.seq || 0) - (a.seq || 0)).slice(0, 20)
                  if (timeoutEvents.length === 0) return null
                  
                  return (
                    <div
                      className="manual-item"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        paddingTop: '16px',
                        borderTop: '1px solid rgba(255,255,255,0.08)'
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: '8px' }}>Edit Timeouts ({timeoutEvents.length} most recent)</div>
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                        Edit or delete timeout events. Score shown is at time of timeout.
                      </div>
                      <div style={{ 
                        maxHeight: '300px', 
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px'
                      }}>
                        {timeoutEvents.map(event => {
                          const setIndex = event.setIndex || 1
                          const team = event.payload?.team
                          const teamLabel = team === teamAKey ? 'A' : (team === teamBKey ? 'B' : '')
                          
                          // Calculate score at time of this timeout
                          const setEvents = data.events.filter(e => e.setIndex === setIndex)
                          const eventIndex = setEvents.findIndex(e => e.id === event.id)
                          let homeScore = 0
                          let awayScore = 0
                          for (let i = 0; i < eventIndex; i++) {
                            const e = setEvents[i]
                            if (e.type === 'point') {
                              if (e.payload?.team === 'home') homeScore++
                              else if (e.payload?.team === 'away') awayScore++
                            }
                          }
                          
                          return (
                            <div key={event.id} style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              padding: '8px',
                              background: 'rgba(255,255,255,0.03)',
                              borderRadius: '4px',
                              fontSize: '11px'
                            }}>
                              <span style={{ minWidth: '60px' }}>Set {setIndex}</span>
                              <select
                                value={team || 'home'}
                                onChange={async (e) => {
                                  await db.events.update(event.id, {
                                    payload: { ...event.payload, team: e.target.value }
                                  })
                                }}
                                style={{
                                  padding: '4px 6px',
                                  fontSize: '11px',
                                  background: '#1e293b',
                                  border: '1px solid rgba(255,255,255,0.2)',
                                  borderRadius: '4px',
                                  color: 'var(--text)',
                                  minWidth: '80px'
                                }}
                              >
                                <option value="home" style={{ background: '#1e293b', color: 'var(--text)' }}>Home</option>
                                <option value="away" style={{ background: '#1e293b', color: 'var(--text)' }}>Away</option>
                              </select>
                              <span style={{ minWidth: '50px' }}>Score: {homeScore}-{awayScore}</span>
                              <button
                                className="danger"
                                onClick={async () => {
                                  if (confirm(`Delete this timeout event?`)) {
                                    await db.events.delete(event.id)
                                  }
                                }}
                                style={{
                                  padding: '4px 8px',
                                  fontSize: '10px',
                                  marginLeft: 'auto'
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
                
                {/* Edit Substitutions */}
                {data?.events && (() => {
                  const substitutionEvents = data.events.filter(e => e.type === 'substitution').sort((a, b) => (b.seq || 0) - (a.seq || 0)).slice(0, 20)
                  if (substitutionEvents.length === 0) return null
                  
                  return (
                    <div
                      className="manual-item"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        paddingTop: '16px',
                        borderTop: '1px solid rgba(255,255,255,0.08)'
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: '8px' }}>Edit Substitutions ({substitutionEvents.length} most recent)</div>
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                        Edit or delete substitution events. Score shown is at time of substitution.
                      </div>
                      <div style={{ 
                        maxHeight: '300px', 
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px'
                      }}>
                        {substitutionEvents.map(event => {
                          const setIndex = event.setIndex || 1
                          const team = event.payload?.team
                          const teamLabel = team === teamAKey ? 'A' : (team === teamBKey ? 'B' : '')
                          const playerOut = event.payload?.playerOut
                          const playerIn = event.payload?.playerIn
                          const position = event.payload?.position
                          
                          // Calculate score at time of this substitution
                          const setEvents = data.events.filter(e => e.setIndex === setIndex)
                          const eventIndex = setEvents.findIndex(e => e.id === event.id)
                          let homeScore = 0
                          let awayScore = 0
                          for (let i = 0; i < eventIndex; i++) {
                            const e = setEvents[i]
                            if (e.type === 'point') {
                              if (e.payload?.team === 'home') homeScore++
                              else if (e.payload?.team === 'away') awayScore++
                            }
                          }
                          
                          return (
                            <div key={event.id} style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '6px',
                              padding: '8px',
                              background: 'rgba(255,255,255,0.03)',
                              borderRadius: '4px',
                              fontSize: '11px'
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                <span style={{ minWidth: '60px' }}>Set {setIndex}</span>
                                <select
                                  value={team || 'home'}
                                  onChange={async (e) => {
                                    await db.events.update(event.id, {
                                      payload: { ...event.payload, team: e.target.value }
                                    })
                                  }}
                                  style={{
                                    padding: '4px 6px',
                                    fontSize: '11px',
                                    background: 'var(--bg-secondary)',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    borderRadius: '4px',
                                    color: 'var(--text)',
                                    minWidth: '80px'
                                  }}
                                >
                                  <option value="home">Home</option>
                                  <option value="away">Away</option>
                                </select>
                                <span style={{ minWidth: '50px' }}>Score: {homeScore}-{awayScore}</span>
                                <button
                                  className="danger"
                                  onClick={async () => {
                                    if (confirm(`Delete this substitution event?`)) {
                                      await db.events.delete(event.id)
                                    }
                                  }}
                                  style={{
                                    padding: '4px 8px',
                                    fontSize: '10px',
                                    marginLeft: 'auto'
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                <label style={{ fontSize: '10px' }}>Position:</label>
                                <select
                                  value={position || 'I'}
                                  onChange={async (e) => {
                                    await db.events.update(event.id, {
                                      payload: { ...event.payload, position: e.target.value }
                                    })
                                  }}
                                  style={{
                                    padding: '4px 6px',
                                    fontSize: '11px',
                                    background: '#1e293b',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    borderRadius: '4px',
                                    color: 'var(--text)',
                                    width: '50px'
                                  }}
                                >
                                  {['I', 'II', 'III', 'IV', 'V', 'VI'].map(pos => (
                                    <option key={pos} value={pos} style={{ background: '#1e293b', color: 'var(--text)' }}>{pos}</option>
                                  ))}
                                </select>
                                <label style={{ fontSize: '10px' }}>Out:</label>
                                <input
                                  type="number"
                                  min="1"
                                  max="99"
                                  value={playerOut || ''}
                                  onChange={async (e) => {
                                    const val = parseInt(e.target.value) || null
                                    await db.events.update(event.id, {
                                      payload: { ...event.payload, playerOut: val }
                                    })
                                  }}
                                  style={{
                                    width: '50px',
                                    padding: '4px 6px',
                                    fontSize: '11px',
                                    background: 'var(--bg-secondary)',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    borderRadius: '4px',
                                    color: 'var(--text)'
                                  }}
                                />
                                <label style={{ fontSize: '10px' }}>In:</label>
                                <input
                                  type="number"
                                  min="1"
                                  max="99"
                                  value={playerIn || ''}
                                  onChange={async (e) => {
                                    const val = parseInt(e.target.value) || null
                                    await db.events.update(event.id, {
                                      payload: { ...event.payload, playerIn: val }
                                    })
                                  }}
                                  style={{
                                    width: '50px',
                                    padding: '4px 6px',
                                    fontSize: '11px',
                                    background: 'var(--bg-secondary)',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    borderRadius: '4px',
                                    color: 'var(--text)'
                                  }}
                                />
                                <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto', flexWrap: 'wrap' }}>
                                  <label style={{ fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <input
                                      type="checkbox"
                                      checked={event.payload?.isInjury || false}
                                      onChange={async (e) => {
                                        await db.events.update(event.id, {
                                          payload: { ...event.payload, isInjury: e.target.checked }
                                        })
                                      }}
                                      style={{ width: '14px', height: '14px', cursor: 'pointer' }}
                                    />
                                    Injury
                                  </label>
                                  <label style={{ fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <input
                                      type="checkbox"
                                      checked={event.payload?.isExceptional || false}
                                      onChange={async (e) => {
                                        await db.events.update(event.id, {
                                          payload: { ...event.payload, isExceptional: e.target.checked }
                                        })
                                      }}
                                      style={{ width: '14px', height: '14px', cursor: 'pointer' }}
                                    />
                                    Exceptional
                                  </label>
                                  <label style={{ fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <input
                                      type="checkbox"
                                      checked={event.payload?.isExpelled || false}
                                      onChange={async (e) => {
                                        await db.events.update(event.id, {
                                          payload: { ...event.payload, isExpelled: e.target.checked }
                                        })
                                      }}
                                      style={{ width: '14px', height: '14px', cursor: 'pointer' }}
                                    />
                                    Expelled
                                  </label>
                                  <label style={{ fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <input
                                      type="checkbox"
                                      checked={event.payload?.isDisqualified || false}
                                      onChange={async (e) => {
                                        await db.events.update(event.id, {
                                          payload: { ...event.payload, isDisqualified: e.target.checked }
                                        })
                                      }}
                                      style={{ width: '14px', height: '14px', cursor: 'pointer' }}
                                    />
                                    Disqualified
                                  </label>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
                
                {/* Edit Sanctions */}
                {data?.events && (() => {
                  const sanctionEvents = data.events.filter(e => e.type === 'sanction').sort((a, b) => (b.seq || 0) - (a.seq || 0)).slice(0, 20)
                  if (sanctionEvents.length === 0) return null
                  
                  return (
                    <div
                      className="manual-item"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        paddingTop: '16px',
                        borderTop: '1px solid rgba(255,255,255,0.08)'
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: '8px' }}>Edit Sanctions ({sanctionEvents.length} most recent)</div>
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                        Edit or delete sanction events. Score shown is at time of sanction.
                      </div>
                      <div style={{ 
                        maxHeight: '300px', 
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px'
                      }}>
                        {sanctionEvents.map(event => {
                          const setIndex = event.setIndex || 1
                          const team = event.payload?.team
                          const teamLabel = team === teamAKey ? 'A' : (team === teamBKey ? 'B' : '')
                          const sanctionType = event.payload?.type
                          const playerNumber = event.payload?.playerNumber
                          const position = event.payload?.position
                          const role = event.payload?.role
                          
                          // Calculate score at time of this sanction
                          const setEvents = data.events.filter(e => e.setIndex === setIndex)
                          const eventIndex = setEvents.findIndex(e => e.id === event.id)
                          let homeScore = 0
                          let awayScore = 0
                          for (let i = 0; i < eventIndex; i++) {
                            const e = setEvents[i]
                            if (e.type === 'point') {
                              if (e.payload?.team === 'home') homeScore++
                              else if (e.payload?.team === 'away') awayScore++
                            }
                          }
                          
                          return (
                            <div key={event.id} style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '6px',
                              padding: '8px',
                              background: 'rgba(255,255,255,0.03)',
                              borderRadius: '4px',
                              fontSize: '11px'
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                <span style={{ minWidth: '60px' }}>Set {setIndex}</span>
                                <select
                                  value={team || 'home'}
                                  onChange={async (e) => {
                                    await db.events.update(event.id, {
                                      payload: { ...event.payload, team: e.target.value }
                                    })
                                  }}
                                  style={{
                                    padding: '4px 6px',
                                    fontSize: '11px',
                                    background: '#1e293b',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    borderRadius: '4px',
                                    color: 'var(--text)',
                                    minWidth: '80px'
                                  }}
                                >
                                  <option value="home" style={{ background: '#1e293b', color: 'var(--text)' }}>Home</option>
                                  <option value="away" style={{ background: '#1e293b', color: 'var(--text)' }}>Away</option>
                                </select>
                                <select
                                  value={sanctionType || 'warning'}
                                  onChange={async (e) => {
                                    await db.events.update(event.id, {
                                      payload: { ...event.payload, type: e.target.value }
                                    })
                                  }}
                                  style={{
                                    padding: '4px 6px',
                                    fontSize: '11px',
                                    background: '#1e293b',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    borderRadius: '4px',
                                    color: 'var(--text)',
                                    minWidth: '120px'
                                  }}
                                >
                                  <option value="warning" style={{ background: '#1e293b', color: 'var(--text)' }}>Warning</option>
                                  <option value="penalty" style={{ background: '#1e293b', color: 'var(--text)' }}>Penalty</option>
                                  <option value="expulsion" style={{ background: '#1e293b', color: 'var(--text)' }}>Expulsion</option>
                                  <option value="disqualification" style={{ background: '#1e293b', color: 'var(--text)' }}>Disqualification</option>
                                  <option value="improper_request" style={{ background: '#1e293b', color: 'var(--text)' }}>Improper Request</option>
                                  <option value="delay_warning" style={{ background: '#1e293b', color: 'var(--text)' }}>Delay Warning</option>
                                  <option value="delay_penalty" style={{ background: '#1e293b', color: 'var(--text)' }}>Delay Penalty</option>
                                </select>
                                <span style={{ minWidth: '50px' }}>Score: {homeScore}-{awayScore}</span>
                                <button
                                  className="danger"
                                  onClick={async () => {
                                    if (confirm(`Delete this sanction event?`)) {
                                      await db.events.delete(event.id)
                                    }
                                  }}
                                  style={{
                                    padding: '4px 8px',
                                    fontSize: '10px',
                                    marginLeft: 'auto'
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                {playerNumber !== undefined && playerNumber !== null && (
                                  <>
                                    <label style={{ fontSize: '10px' }}>Player:</label>
                                    <input
                                      type="number"
                                      min="1"
                                      max="99"
                                      value={playerNumber || ''}
                                      onChange={async (e) => {
                                        const val = parseInt(e.target.value) || null
                                        await db.events.update(event.id, {
                                          payload: { ...event.payload, playerNumber: val }
                                        })
                                      }}
                                      style={{
                                        width: '50px',
                                        padding: '4px 6px',
                                        fontSize: '11px',
                                        background: 'var(--bg-secondary)',
                                        border: '1px solid rgba(255,255,255,0.2)',
                                        borderRadius: '4px',
                                        color: 'var(--text)'
                                      }}
                                    />
                                  </>
                                )}
                                {position && (
                                  <>
                                    <label style={{ fontSize: '10px' }}>Position:</label>
                                    <select
                                      value={position || 'I'}
                                      onChange={async (e) => {
                                        await db.events.update(event.id, {
                                          payload: { ...event.payload, position: e.target.value }
                                        })
                                      }}
                                      style={{
                                        padding: '4px 6px',
                                        fontSize: '11px',
                                        background: 'var(--bg-secondary)',
                                        border: '1px solid rgba(255,255,255,0.2)',
                                        borderRadius: '4px',
                                        color: 'var(--text)',
                                        width: '50px'
                                      }}
                                    >
                                      {['I', 'II', 'III', 'IV', 'V', 'VI'].map(pos => (
                                        <option key={pos} value={pos}>{pos}</option>
                                      ))}
                                    </select>
                                  </>
                                )}
                                {role && (
                                  <>
                                    <label style={{ fontSize: '10px' }}>Role:</label>
                                    <select
                                      value={role || 'Coach'}
                                      onChange={async (e) => {
                                        await db.events.update(event.id, {
                                          payload: { ...event.payload, role: e.target.value }
                                        })
                                      }}
                                      style={{
                                        padding: '4px 6px',
                                        fontSize: '11px',
                                        background: '#1e293b',
                                        border: '1px solid rgba(255,255,255,0.2)',
                                        borderRadius: '4px',
                                        color: 'var(--text)',
                                        minWidth: '120px'
                                      }}
                                    >
                                      <option value="Coach" style={{ background: '#1e293b', color: 'var(--text)' }}>Coach</option>
                                      <option value="Assistant Coach 1" style={{ background: '#1e293b', color: 'var(--text)' }}>Assistant Coach 1</option>
                                      <option value="Assistant Coach 2" style={{ background: '#1e293b', color: 'var(--text)' }}>Assistant Coach 2</option>
                                      <option value="Physiotherapist" style={{ background: '#1e293b', color: 'var(--text)' }}>Physiotherapist</option>
                                      <option value="Medic" style={{ background: '#1e293b', color: 'var(--text)' }}>Medic</option>
                                    </select>
                                  </>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
                
                {/* Edit Libero Actions */}
                {data?.events && (() => {
                  const liberoEvents = data.events.filter(e => 
                    e.type === 'libero_entry' || 
                    e.type === 'libero_exit' || 
                    e.type === 'libero_substitution' ||
                    e.type === 'libero_unable' ||
                    e.type === 'libero_redesignation'
                  ).sort((a, b) => (b.seq || 0) - (a.seq || 0)).slice(0, 20)
                  if (liberoEvents.length === 0) return null
                  
                  return (
                    <div
                      className="manual-item"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        paddingTop: '16px',
                        borderTop: '1px solid rgba(255,255,255,0.08)'
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: '8px' }}>Edit Libero Actions ({liberoEvents.length} most recent)</div>
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                        Edit or delete libero-related events.
                      </div>
                      <div style={{ 
                        maxHeight: '300px', 
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px'
                      }}>
                        {liberoEvents.map(event => {
                          const setIndex = event.setIndex || 1
                          const team = event.payload?.team
                          const teamLabel = team === teamAKey ? 'A' : (team === teamBKey ? 'B' : '')
                          const eventType = event.type
                          
                          // Calculate score at time of this event
                          const setEvents = data.events.filter(e => e.setIndex === setIndex)
                          const eventIndex = setEvents.findIndex(e => e.id === event.id)
                          let homeScore = 0
                          let awayScore = 0
                          for (let i = 0; i < eventIndex; i++) {
                            const e = setEvents[i]
                            if (e.type === 'point') {
                              if (e.payload?.team === 'home') homeScore++
                              else if (e.payload?.team === 'away') awayScore++
                            }
                          }
                          
                          return (
                            <div key={event.id} style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '6px',
                              padding: '8px',
                              background: 'rgba(255,255,255,0.03)',
                              borderRadius: '4px',
                              fontSize: '11px'
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                <span style={{ minWidth: '60px' }}>Set {setIndex}</span>
                                <span style={{ minWidth: '100px', fontSize: '10px', fontWeight: 600 }}>
                                  {eventType.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                                </span>
                                <select
                                  value={team || 'home'}
                                  onChange={async (e) => {
                                    await db.events.update(event.id, {
                                      payload: { ...event.payload, team: e.target.value }
                                    })
                                  }}
                                  style={{
                                    padding: '4px 6px',
                                    fontSize: '11px',
                                    background: '#1e293b',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    borderRadius: '4px',
                                    color: 'var(--text)',
                                    minWidth: '80px'
                                  }}
                                >
                                  <option value="home" style={{ background: '#1e293b', color: 'var(--text)' }}>Home</option>
                                  <option value="away" style={{ background: '#1e293b', color: 'var(--text)' }}>Away</option>
                                </select>
                                <span style={{ minWidth: '50px' }}>Score: {homeScore}-{awayScore}</span>
                                <button
                                  className="danger"
                                  onClick={async () => {
                                    if (confirm(`Delete this ${eventType} event?`)) {
                                      await db.events.delete(event.id)
                                    }
                                  }}
                                  style={{
                                    padding: '4px 8px',
                                    fontSize: '10px',
                                    marginLeft: 'auto'
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                              {eventType === 'libero_entry' && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                  <label style={{ fontSize: '10px' }}>Libero #:</label>
                                  <input
                                    type="number"
                                    min="1"
                                    max="99"
                                    value={event.payload?.liberoIn || ''}
                                    onChange={async (e) => {
                                      const val = parseInt(e.target.value) || null
                                      await db.events.update(event.id, {
                                        payload: { ...event.payload, liberoIn: val }
                                      })
                                    }}
                                    style={{
                                      width: '50px',
                                      padding: '4px 6px',
                                      fontSize: '11px',
                                      background: 'var(--bg-secondary)',
                                      border: '1px solid rgba(255,255,255,0.2)',
                                      borderRadius: '4px',
                                      color: 'var(--text)'
                                    }}
                                  />
                                  <label style={{ fontSize: '10px' }}>Player Out:</label>
                                  <input
                                    type="number"
                                    min="1"
                                    max="99"
                                    value={event.payload?.playerOut || ''}
                                    onChange={async (e) => {
                                      const val = parseInt(e.target.value) || null
                                      await db.events.update(event.id, {
                                        payload: { ...event.payload, playerOut: val }
                                      })
                                    }}
                                    style={{
                                      width: '50px',
                                      padding: '4px 6px',
                                      fontSize: '11px',
                                      background: 'var(--bg-secondary)',
                                      border: '1px solid rgba(255,255,255,0.2)',
                                      borderRadius: '4px',
                                      color: 'var(--text)'
                                    }}
                                  />
                                  <label style={{ fontSize: '10px' }}>Type:</label>
                                  <select
                                    value={event.payload?.liberoType || 'libero1'}
                                    onChange={async (e) => {
                                      await db.events.update(event.id, {
                                        payload: { ...event.payload, liberoType: e.target.value }
                                      })
                                    }}
                                    style={{
                                      padding: '4px 6px',
                                      fontSize: '11px',
                                      background: '#1e293b',
                                      border: '1px solid rgba(255,255,255,0.2)',
                                      borderRadius: '4px',
                                      color: 'var(--text)',
                                      minWidth: '80px'
                                    }}
                                  >
                                    <option value="libero1" style={{ background: '#1e293b', color: 'var(--text)' }}>L1</option>
                                    <option value="libero2" style={{ background: '#1e293b', color: 'var(--text)' }}>L2</option>
                                  </select>
                                </div>
                              )}
                              {eventType === 'libero_exit' && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                  <label style={{ fontSize: '10px' }}>Libero Out:</label>
                                  <input
                                    type="number"
                                    min="1"
                                    max="99"
                                    value={event.payload?.liberoOut || ''}
                                    onChange={async (e) => {
                                      const val = parseInt(e.target.value) || null
                                      await db.events.update(event.id, {
                                        payload: { ...event.payload, liberoOut: val }
                                      })
                                    }}
                                    style={{
                                      width: '50px',
                                      padding: '4px 6px',
                                      fontSize: '11px',
                                      background: 'var(--bg-secondary)',
                                      border: '1px solid rgba(255,255,255,0.2)',
                                      borderRadius: '4px',
                                      color: 'var(--text)'
                                    }}
                                  />
                                  <label style={{ fontSize: '10px' }}>Player In:</label>
                                  <input
                                    type="number"
                                    min="1"
                                    max="99"
                                    value={event.payload?.playerIn || ''}
                                    onChange={async (e) => {
                                      const val = parseInt(e.target.value) || null
                                      await db.events.update(event.id, {
                                        payload: { ...event.payload, playerIn: val }
                                      })
                                    }}
                                    style={{
                                      width: '50px',
                                      padding: '4px 6px',
                                      fontSize: '11px',
                                      background: 'var(--bg-secondary)',
                                      border: '1px solid rgba(255,255,255,0.2)',
                                      borderRadius: '4px',
                                      color: 'var(--text)'
                                    }}
                                  />
                                </div>
                              )}
                              {eventType === 'libero_unable' && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                  <label style={{ fontSize: '10px' }}>Libero #:</label>
                                  <input
                                    type="number"
                                    min="1"
                                    max="99"
                                    value={event.payload?.liberoNumber || ''}
                                    onChange={async (e) => {
                                      const val = parseInt(e.target.value) || null
                                      await db.events.update(event.id, {
                                        payload: { ...event.payload, liberoNumber: val }
                                      })
                                    }}
                                    style={{
                                      width: '50px',
                                      padding: '4px 6px',
                                      fontSize: '11px',
                                      background: 'var(--bg-secondary)',
                                      border: '1px solid rgba(255,255,255,0.2)',
                                      borderRadius: '4px',
                                      color: 'var(--text)'
                                    }}
                                  />
                                  <label style={{ fontSize: '10px' }}>Reason:</label>
                                  <select
                                    value={event.payload?.reason || 'injury'}
                                    onChange={async (e) => {
                                      await db.events.update(event.id, {
                                        payload: { ...event.payload, reason: e.target.value }
                                      })
                                    }}
                                    style={{
                                      padding: '4px 6px',
                                      fontSize: '11px',
                                      background: '#1e293b',
                                      border: '1px solid rgba(255,255,255,0.2)',
                                      borderRadius: '4px',
                                      color: 'var(--text)',
                                      minWidth: '120px'
                                    }}
                                  >
                                    <option value="injury" style={{ background: '#1e293b', color: 'var(--text)' }}>Injury</option>
                                    <option value="expulsion" style={{ background: '#1e293b', color: 'var(--text)' }}>Expulsion</option>
                                    <option value="disqualification" style={{ background: '#1e293b', color: 'var(--text)' }}>Disqualification</option>
                                  </select>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
                
                {/* Edit Lineups */}
                {data?.events && (() => {
                  const lineupEvents = data.events.filter(e => e.type === 'lineup' && e.payload?.isInitial).sort((a, b) => (b.seq || 0) - (a.seq || 0)).slice(0, 10)
                  if (lineupEvents.length === 0) return null
                  
                  return (
                    <div
                      className="manual-item"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        paddingTop: '16px',
                        borderTop: '1px solid rgba(255,255,255,0.08)'
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: '8px' }}>Edit Initial Lineups ({lineupEvents.length} most recent)</div>
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                        Edit or delete initial lineup events.
                      </div>
                      <div style={{ 
                        maxHeight: '300px', 
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px'
                      }}>
                        {lineupEvents.map(event => {
                          const setIndex = event.setIndex || 1
                          const team = event.payload?.team
                          const teamLabel = team === teamAKey ? 'A' : (team === teamBKey ? 'B' : '')
                          const lineup = event.payload?.lineup || {}
                          
                          return (
                            <div key={event.id} style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '6px',
                              padding: '8px',
                              background: 'rgba(255,255,255,0.03)',
                              borderRadius: '4px',
                              fontSize: '11px'
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                <span style={{ minWidth: '60px' }}>Set {setIndex}</span>
                                <select
                                  value={team || 'home'}
                                  onChange={async (e) => {
                                    await db.events.update(event.id, {
                                      payload: { ...event.payload, team: e.target.value }
                                    })
                                  }}
                                  style={{
                                    padding: '4px 6px',
                                    fontSize: '11px',
                                    background: 'var(--bg-secondary)',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    borderRadius: '4px',
                                    color: 'var(--text)',
                                    minWidth: '80px'
                                  }}
                                >
                                  <option value="home">Home</option>
                                  <option value="away">Away</option>
                                </select>
                                <button
                                  className="secondary"
                                  onClick={() => {
                                    setLineupModal({ team, mode: 'manual', lineup })
                                    setShowManualPanel(false)
                                  }}
                                  style={{
                                    padding: '4px 8px',
                                    fontSize: '10px'
                                  }}
                                >
                                  Edit Lineup
                                </button>
                                <button
                                  className="danger"
                                  onClick={async () => {
                                    if (confirm(`Delete this lineup event?`)) {
                                      await db.events.delete(event.id)
                                    }
                                  }}
                                  style={{
                                    padding: '4px 8px',
                                    fontSize: '10px',
                                    marginLeft: 'auto'
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                              <div style={{ fontSize: '10px', color: 'var(--muted)' }}>
                                I: {lineup.I || '-'} | II: {lineup.II || '-'} | III: {lineup.III || '-'} | IV: {lineup.IV || '-'} | V: {lineup.V || '-'} | VI: {lineup.VI || '-'}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
                
                {/* Edit Set Times */}
                {data?.sets && data.sets.length > 0 && (
                  <div
                    className="manual-item"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      paddingTop: '16px',
                      borderTop: '1px solid rgba(255,255,255,0.08)'
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: '8px' }}>Edit Set Times</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                      Edit start and end times for sets.
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {data.sets.sort((a, b) => a.index - b.index).map(set => (
                        <div key={set.id} style={{ 
                          display: 'flex', 
                          flexDirection: 'column',
                          gap: '8px',
                          padding: '8px',
                          background: 'rgba(255,255,255,0.03)',
                          borderRadius: '6px'
                        }}>
                          <div style={{ fontWeight: 600, fontSize: '12px' }}>Set {set.index}</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <label style={{ fontSize: '11px', minWidth: '80px' }}>Start Time:</label>
                              <input
                                type="datetime-local"
                                value={set.startTime ? new Date(set.startTime).toISOString().slice(0, 16) : ''}
                                onChange={async (e) => {
                                  const newTime = e.target.value ? new Date(e.target.value).toISOString() : null
                                  await db.sets.update(set.id, { startTime: newTime })
                                }}
                                style={{
                                  padding: '4px 6px',
                                  fontSize: '11px',
                                  background: 'var(--bg-secondary)',
                                  border: '1px solid rgba(255,255,255,0.2)',
                                  borderRadius: '4px',
                                  color: 'var(--text)'
                                }}
                              />
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <label style={{ fontSize: '11px', minWidth: '80px' }}>End Time:</label>
                              <input
                                type="datetime-local"
                                value={set.endTime ? new Date(set.endTime).toISOString().slice(0, 16) : ''}
                                onChange={async (e) => {
                                  const newTime = e.target.value ? new Date(e.target.value).toISOString() : null
                                  await db.sets.update(set.id, { endTime: newTime })
                                }}
                                style={{
                                  padding: '4px 6px',
                                  fontSize: '11px',
                                  background: 'var(--bg-secondary)',
                                  border: '1px solid rgba(255,255,255,0.2)',
                                  borderRadius: '4px',
                                  color: 'var(--text)'
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Add New Event */}
                <div
                  className="manual-item"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    paddingTop: '16px',
                    borderTop: '1px solid rgba(255,255,255,0.08)'
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: '8px' }}>Add New Event</div>
                  <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                    Manually add a new event to the match history.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <label style={{ fontSize: '12px', minWidth: '100px' }}>Event Type:</label>
                      <select
                        id="newEventType"
                        style={{
                          flex: 1,
                          padding: '6px 8px',
                          fontSize: '12px',
                          background: '#1e293b',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)'
                        }}
                      >
                        <option value="point" style={{ background: '#1e293b', color: 'var(--text)' }}>Point</option>
                        <option value="timeout" style={{ background: '#1e293b', color: 'var(--text)' }}>Timeout</option>
                        <option value="substitution" style={{ background: '#1e293b', color: 'var(--text)' }}>Substitution</option>
                        <option value="sanction" style={{ background: '#1e293b', color: 'var(--text)' }}>Sanction</option>
                        <option value="lineup" style={{ background: '#1e293b', color: 'var(--text)' }}>Lineup</option>
                        <option value="libero_entry" style={{ background: '#1e293b', color: 'var(--text)' }}>Libero Entry</option>
                        <option value="libero_exit" style={{ background: '#1e293b', color: 'var(--text)' }}>Libero Exit</option>
                        <option value="libero_substitution" style={{ background: '#1e293b', color: 'var(--text)' }}>Libero Substitution</option>
                        <option value="libero_unable" style={{ background: '#1e293b', color: 'var(--text)' }}>Libero Unable</option>
                        <option value="replay" style={{ background: '#1e293b', color: 'var(--text)' }}>Replay</option>
                        <option value="rally_start" style={{ background: '#1e293b', color: 'var(--text)' }}>Rally Start</option>
                        <option value="set_start" style={{ background: '#1e293b', color: 'var(--text)' }}>Set Start</option>
                        <option value="set_end" style={{ background: '#1e293b', color: 'var(--text)' }}>Set End</option>
                      </select>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <label style={{ fontSize: '12px', minWidth: '100px' }}>Set:</label>
                      <select
                        id="newEventSet"
                        style={{
                          flex: 1,
                          padding: '6px 8px',
                          fontSize: '12px',
                          background: '#1e293b',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)'
                        }}
                      >
                        {data?.sets?.sort((a, b) => a.index - b.index).map(set => (
                          <option key={set.id} value={set.index} style={{ background: '#1e293b', color: 'var(--text)' }}>Set {set.index}</option>
                        ))}
                      </select>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <label style={{ fontSize: '12px', minWidth: '100px' }}>Team:</label>
                      <select
                        id="newEventTeam"
                        style={{
                          flex: 1,
                          padding: '6px 8px',
                          fontSize: '12px',
                          background: '#1e293b',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)'
                        }}
                      >
                        <option value="home" style={{ background: '#1e293b', color: 'var(--text)' }}>Home</option>
                        <option value="away" style={{ background: '#1e293b', color: 'var(--text)' }}>Away</option>
                      </select>
                    </div>
                    <button
                      className="secondary"
                      onClick={async () => {
                        const eventType = document.getElementById('newEventType')?.value
                        const setIndex = parseInt(document.getElementById('newEventSet')?.value || '1')
                        const team = document.getElementById('newEventTeam')?.value
                        
                        if (!eventType || !setIndex || !team) {
                          alert('Please fill in all fields')
                          return
                        }
                        
                        // Get next sequence number
                        const allEvents = await db.events.where('matchId').equals(matchId).toArray()
                        const maxSeq = allEvents.reduce((max, e) => Math.max(max, e.seq || 0), 0)
                        
                        const payload = { team }
                        
                        // Add type-specific fields
                        if (eventType === 'substitution') {
                          payload.position = 'I'
                          payload.playerOut = null
                          payload.playerIn = null
                        } else if (eventType === 'sanction') {
                          payload.type = 'warning'
                        } else if (eventType === 'lineup') {
                          payload.lineup = { I: null, II: null, III: null, IV: null, V: null, VI: null }
                          payload.isInitial = true
                        } else if (eventType === 'libero_entry') {
                          payload.liberoIn = null
                          payload.playerOut = null
                          payload.liberoType = 'libero1'
                        } else if (eventType === 'libero_exit') {
                          payload.liberoOut = null
                          payload.playerIn = null
                        } else if (eventType === 'libero_unable') {
                          payload.liberoNumber = null
                          payload.liberoType = 'libero1'
                          payload.reason = 'injury'
                        }
                        
                        const debugSeq = maxSeq + 1
                        const debugEventId = await db.events.add({
                          matchId,
                          setIndex,
                          type: eventType,
                          payload,
                          ts: new Date().toISOString(),
                          seq: debugSeq
                        })

                        alert('Event added. You can now edit it in the sections above.')
                      }}
                      style={{
                        padding: '8px 16px',
                        fontSize: '12px'
                      }}
                    >
                      Add Event
                    </button>
                  </div>
                </div>
                
                {/* Delete Events (Simple List) */}
                {data?.events && data.events.length > 0 && (
                  <div
                    className="manual-item"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      paddingTop: '16px',
                      borderTop: '1px solid rgba(255,255,255,0.08)'
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: '8px' }}>Delete Events (Quick)</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                      Quick delete for any event. Use with caution.
                    </div>
                    <div style={{ 
                      maxHeight: '200px', 
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px'
                    }}>
                      {data.events
                        .sort((a, b) => {
                          const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
                          const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
                          return bTime - aTime
                        })
                        .slice(0, 30)
                        .map(event => {
                          const eventType = event.type
                          const setIndex = event.setIndex || 1
                          const team = event.payload?.team
                          const teamLabel = team === teamAKey ? 'A' : (team === teamBKey ? 'B' : '')
                          const description = eventType === 'point' ? `Point ${teamLabel}` :
                                            eventType === 'timeout' ? `Timeout ${teamLabel}` :
                                            eventType === 'substitution' ? `Substitution ${teamLabel}` :
                                            eventType === 'lineup' ? `Lineup ${teamLabel}` :
                                            eventType === 'sanction' ? `Sanction ${teamLabel}` :
                                            eventType === 'libero_entry' ? `Libero Entry ${teamLabel}` :
                                            eventType === 'libero_exit' ? `Libero Exit ${teamLabel}` :
                                            eventType === 'libero_substitution' ? `Libero Sub ${teamLabel}` :
                                            eventType === 'libero_unable' ? `Libero Unable ${teamLabel}` :
                                            eventType
                          
                          return (
                            <div key={event.id} style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '6px 8px',
                              background: 'rgba(255,255,255,0.03)',
                              borderRadius: '4px',
                              fontSize: '11px'
                            }}>
                              <span>
                                Set {setIndex} - {description}
                              </span>
                              <button
                                className="danger"
                                onClick={async () => {
                                  if (confirm(`Delete this ${eventType} event?`)) {
                                    await db.events.delete(event.id)
                                  }
                                }}
                                style={{
                                  padding: '4px 8px',
                                  fontSize: '10px'
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          )
                        })}
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>
        </Modal>
      )}

      {/* Remarks Modal */}
      {showRemarks && (
        <Modal
          title="Remarks Recording"
          open={true}
          onClose={() => {
            setShowRemarks(false)
            setRemarksText('')
          }}
          width={600}
        >
          <div style={{ padding: '20px', maxHeight: '80vh', overflowY: 'auto' }}>
            <section className="panel">
              <h3>Remarks</h3>
              <textarea
                ref={remarksTextareaRef}
                className="remarks-area"
                placeholder="Record match remarks…"
                value={remarksText}
                onChange={e => {
                  setRemarksText(e.target.value)
                }}
                onBlur={async () => {
                  // When user finishes editing, save and log as event
                  const oldRemarks = data?.match?.remarks || ''
                  const newRemarks = remarksText.trim()
                  
                  if (newRemarks !== oldRemarks) {
                    // Save the new remarks
                    await db.matches.update(matchId, { remarks: newRemarks })
                    
                    // Log remark insertion as an event if new text was added
                    if (data?.set && newRemarks) {
                      // Get the added text (what's new compared to old)
                      const oldLines = oldRemarks.split('\n')
                      const newLines = newRemarks.split('\n')
                      
                      // Find what was added (new lines that weren't in old)
                      const addedLines = newLines.filter((line, idx) => {
                        // If old remarks is empty, all new lines are added
                        if (!oldRemarks) return line.trim()
                        // Check if this line is new (not in old remarks)
                        return idx >= oldLines.length || line !== oldLines[idx]
                      }).filter(line => line.trim())
                      
                      if (addedLines.length > 0) {
                        const addedText = addedLines.join('\n')
                        await logEvent('remark', {
                          text: addedText,
                          fullRemarks: newRemarks
                        })
                      }
                    }
                  }
                }}
                style={{
                  width: '95%',
                  minHeight: '300px',
                  fontSize: '14px',
                  fontFamily: 'monospace',
                  background: 'var(--bg-secondary)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '6px',
                  color: 'var(--text)',
                  resize: 'vertical'
                }}
              />
              <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--muted)' }}>
                <div>• Existing remarks are shown above</div>
                <div>• Add new remarks on a new line</div>
                <div>• Changes are saved automatically when you click outside the textarea</div>
              </div>
            </section>
          </div>
        </Modal>
      )}

      {/* Sanctions and Results Modal */}
      {showSanctions && (
        <Modal
          title="Sanctions and Results"
          open={true}
          onClose={() => setShowSanctions(false)}
          width={1000}
        >
          <div style={{ padding: '20px', maxHeight: '80vh', overflowY: 'auto' }}>
            <section className="panel">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '32px', overflowX: 'auto' }}>
                {/* Left half: Sanctions */}
                <div>
                  <h4 style={{ marginBottom: '16px', fontSize: '14px', fontWeight: 600 }}>Sanctions</h4>
                  {/* Improper Request Row */}
                  <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ fontWeight: 600, fontSize: '12px', minWidth: '100px' }}>Improper Request:</div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {['A', 'B'].map(team => {
                        const teamKey = team === 'A' ? teamAKey : teamBKey
                        const sideKey = (team === 'A' && teamAKey === 'home' && leftIsHome) || (team === 'A' && teamAKey === 'away' && !leftIsHome) || (team === 'B' && teamBKey === 'home' && leftIsHome) || (team === 'B' && teamBKey === 'away' && !leftIsHome) ? 'Left' : 'Right'
                        const hasImproperRequest = data?.match?.sanctions?.[`improperRequest${sideKey}`]
                        
                        return (
                          <div key={team} style={{
                            width: '28px',
                            height: '28px',
                            borderRadius: '50%',
                            border: '2px solid rgba(255,255,255,0.3)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '12px',
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
                                fontSize: '20px',
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
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid rgba(255,255,255,0.2)' }}>
                        <th style={{ padding: '6px 4px', textAlign: 'center', fontWeight: 600 }}>Warn</th>
                        <th style={{ padding: '6px 4px', textAlign: 'center', fontWeight: 600 }}>Pen</th>
                        <th style={{ padding: '6px 4px', textAlign: 'center', fontWeight: 600 }}>Exp</th>
                        <th style={{ padding: '6px 4px', textAlign: 'center', fontWeight: 600 }}>Disq</th>
                        <th style={{ padding: '6px 4px', textAlign: 'center', fontWeight: 600 }}>Team</th>
                        <th style={{ padding: '6px 4px', textAlign: 'center', fontWeight: 600 }}>Set</th>
                        <th style={{ padding: '6px 4px', textAlign: 'center', fontWeight: 600 }}>Score</th>
                      </tr>
                    </thead>
                    <tbody>
                    {(() => {
                      // Get all sanction events except improper_request (already shown in box above)
                      const sanctionEvents = (data?.events || []).filter(e => 
                        e.type === 'sanction' && e.payload?.type !== 'improper_request'
                      )
                      
                      if (sanctionEvents.length === 0) {
                        return (
                          <tr>
                            <td colSpan="7" style={{ padding: '12px', textAlign: 'center', color: 'var(--muted)', fontSize: '11px' }}>
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
                          const playerType = event.payload?.playerType
                          const playerNumber = event.payload?.playerNumber
                          const role = event.payload?.role
                          
                          // Get the identifier to display (player number or role abbreviation)
                          let identifier = null
                          if (role) {
                            identifier = role === 'Coach' ? 'C' : 
                                         role === 'Assistant Coach 1' ? 'AC1' :
                                         role === 'Assistant Coach 2' ? 'AC2' :
                                         role === 'Physiotherapist' ? 'P' :
                                         role === 'Medic' ? 'M' : role
                          } else if (playerNumber !== undefined && playerNumber !== null) {
                            identifier = String(playerNumber)
                          }
                          
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
                          
                          const sanctionedTeamScore = team === 'home' ? homeScore : awayScore
                          const otherTeamScore = team === 'home' ? awayScore : homeScore
                          const scoreDisplay = `${sanctionedTeamScore}:${otherTeamScore}`
                          
                          return (
                            <tr key={event.id || idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                              <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                                {sanctionType === 'warning' && identifier}
                                {sanctionType === 'delay_warning' && !identifier && 'D'}
                              </td>
                              <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                                {sanctionType === 'penalty' && identifier}
                                {sanctionType === 'delay_penalty' && !identifier && 'D'}
                              </td>
                              <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                                {sanctionType === 'expulsion' && identifier}
                              </td>
                              <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                                {sanctionType === 'disqualification' && identifier}
                              </td>
                              <td style={{ padding: '6px 4px', textAlign: 'center', fontWeight: 600 }}>{teamLabel}</td>
                              <td style={{ padding: '6px 4px', textAlign: 'center' }}>{setIndex}</td>
                              <td style={{ padding: '6px 4px', textAlign: 'center' }}>{scoreDisplay}</td>
                            </tr>
                          )
                        })
                      })()}
                    </tbody>
                  </table>
                </div>
                
                {/* Right half: Results */}
                <div>
                <h4 style={{ marginBottom: '16px', fontSize: '14px', fontWeight: 600 }}>Results</h4>
                  {(() => {
                    // Get current left and right teams
                    const currentLeftTeamKey = leftIsHome ? 'home' : 'away'
                    const currentRightTeamKey = leftIsHome ? 'away' : 'home'
                    const leftTeamData = currentLeftTeamKey === 'home' ? data?.homeTeam : data?.awayTeam
                    const rightTeamData = currentRightTeamKey === 'home' ? data?.homeTeam : data?.awayTeam
                    const leftTeamColor = leftTeamData?.color || (currentLeftTeamKey === 'home' ? '#ef4444' : '#3b82f6')
                    const rightTeamColor = rightTeamData?.color || (currentRightTeamKey === 'home' ? '#ef4444' : '#3b82f6')
                    const leftTeamName = leftTeamData?.name || 'Left Team'
                    const rightTeamName = rightTeamData?.name || 'Right Team'
                    const leftTeamLabel = currentLeftTeamKey === teamAKey ? 'A' : 'B'
                    const rightTeamLabel = currentRightTeamKey === teamAKey ? 'A' : 'B'
                    
                    // Get all sets including current
                    const allSets = (data?.sets || []).sort((a, b) => a.index - b.index)
                    const finishedSets = allSets.filter(s => s.finished)
                    
                    // Check if match is final
                    const isMatchFinal = data?.match?.status === 'final'
                    
                    // If match is final, show match results table
                    if (isMatchFinal) {
                      // Calculate totals for each team
                      const leftTotalTimeouts = finishedSets.reduce((sum, set) => {
                        return sum + (data?.events || []).filter(e => 
                          e.type === 'timeout' && e.setIndex === set.index && e.payload?.team === currentLeftTeamKey
                        ).length
                      }, 0)
                      const rightTotalTimeouts = finishedSets.reduce((sum, set) => {
                        return sum + (data?.events || []).filter(e => 
                          e.type === 'timeout' && e.setIndex === set.index && e.payload?.team === currentRightTeamKey
                        ).length
                      }, 0)
                      
                      const leftTotalSubs = finishedSets.reduce((sum, set) => {
                        return sum + (data?.events || []).filter(e => 
                          e.type === 'substitution' && e.setIndex === set.index && e.payload?.team === currentLeftTeamKey
                        ).length
                      }, 0)
                      const rightTotalSubs = finishedSets.reduce((sum, set) => {
                        return sum + (data?.events || []).filter(e => 
                          e.type === 'substitution' && e.setIndex === set.index && e.payload?.team === currentRightTeamKey
                        ).length
                      }, 0)
                      
                      const leftTotalWins = finishedSets.filter(s => {
                        const leftPoints = currentLeftTeamKey === 'home' ? s.homePoints : s.awayPoints
                        const rightPoints = currentRightTeamKey === 'home' ? s.homePoints : s.awayPoints
                        return leftPoints > rightPoints
                      }).length
                      const rightTotalWins = finishedSets.filter(s => {
                        const leftPoints = currentLeftTeamKey === 'home' ? s.homePoints : s.awayPoints
                        const rightPoints = currentRightTeamKey === 'home' ? s.homePoints : s.awayPoints
                        return rightPoints > leftPoints
                      }).length
                      
                      const leftTotalPoints = finishedSets.reduce((sum, set) => {
                        return sum + (currentLeftTeamKey === 'home' ? set.homePoints : set.awayPoints)
                      }, 0)
                      const rightTotalPoints = finishedSets.reduce((sum, set) => {
                        return sum + (currentRightTeamKey === 'home' ? set.homePoints : set.awayPoints)
                      }, 0)
                      
                      // Calculate total match duration
                      let totalDurationMin = 0
                      finishedSets.forEach(set => {
                        if (set.startTime && set.endTime) {
                          const start = new Date(set.startTime)
                          const end = new Date(set.endTime)
                          const durationMs = end - start
                          totalDurationMin += Math.floor(durationMs / 60000)
                        }
                      })
                      
                      // Find match start time (first set_start event or first set startTime)
                      const firstSetStartEvent = (data?.events || []).find(e => e.type === 'set_start' && e.setIndex === 1)
                      const matchStartTime = firstSetStartEvent ? new Date(firstSetStartEvent.ts) : (finishedSets[0]?.startTime ? new Date(finishedSets[0].startTime) : null)
                      
                      // Find match end time (last set endTime)
                      const matchEndTime = finishedSets.length > 0 && finishedSets[finishedSets.length - 1]?.endTime 
                        ? new Date(finishedSets[finishedSets.length - 1].endTime) 
                        : null
                      
                      // Calculate match duration
                      let matchDurationMin = 0
                      if (matchStartTime && matchEndTime) {
                        const durationMs = matchEndTime - matchStartTime
                        matchDurationMin = Math.floor(durationMs / 60000)
                      }
                      
                      // Determine winner
                      const winnerTeamKey = leftTotalWins > rightTotalWins ? currentLeftTeamKey : currentRightTeamKey
                      const winnerTeamData = winnerTeamKey === 'home' ? data?.homeTeam : data?.awayTeam
                      const winnerTeamName = winnerTeamData?.name || (winnerTeamKey === 'home' ? 'Home' : 'Away')
                      const winnerScore = `${leftTotalWins}-${rightTotalWins}`
                      
                      // Get captain signatures
                      const homeCaptainSignature = data?.match?.postMatchSignatureHomeCaptain || null
                      const awayCaptainSignature = data?.match?.postMatchSignatureAwayCaptain || null
                      
                      return (
                        <div>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '9px' }}>
                            <thead>
                              <tr>
                                <th colSpan="4" style={{ padding: '4px', textAlign: 'center', borderBottom: '1px solid rgba(255,255,255,0.2)', width: '42%' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: '10px', wordBreak: 'break-word' }}>{leftTeamName}</span>
                                    <span style={{
                                      padding: '1px 6px',
                                      borderRadius: '3px',
                                      fontSize: '9px',
                                      fontWeight: 700,
                                      background: leftTeamColor,
                                      color: isBrightColor(leftTeamColor) ? '#000' : '#fff'
                                    }}>{leftTeamLabel}</span>
                                  </div>
                                </th>
                                <th style={{ padding: '4px', fontSize: '8px', width: '16%' }}>Dur</th>
                                <th colSpan="4" style={{ padding: '4px', textAlign: 'center', borderBottom: '1px solid rgba(255,255,255,0.2)', width: '42%' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: '10px', wordBreak: 'break-word' }}>{rightTeamName}</span>
                                    <span style={{
                                      padding: '1px 6px',
                                      borderRadius: '3px',
                                      fontSize: '9px',
                                      fontWeight: 700,
                                      background: rightTeamColor,
                                      color: isBrightColor(rightTeamColor) ? '#000' : '#fff'
                                    }}>{rightTeamLabel}</span>
                                  </div>
                                </th>
                              </tr>
                              <tr style={{ borderBottom: '2px solid rgba(255,255,255,0.2)' }}>
                                <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>T</th>
                                <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>S</th>
                                <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>W</th>
                                <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>P</th>
                                <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}></th>
                                <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>P</th>
                                <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>W</th>
                                <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>S</th>
                                <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>T</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                                <td style={{ padding: '4px 2px', textAlign: 'center' }}>{leftTotalTimeouts}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center' }}>{leftTotalSubs}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center' }}>{leftTotalWins}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center' }}>{leftTotalPoints}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center', fontSize: '8px', color: 'var(--muted)' }}>{totalDurationMin}'</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center' }}>{rightTotalPoints}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center' }}>{rightTotalWins}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center' }}>{rightTotalSubs}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center' }}>{rightTotalTimeouts}</td>
                              </tr>
                            </tbody>
                          </table>
                          
                          {/* Match time information */}
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '9px', marginTop: '12px' }}>
                            <tbody>
                              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                                <td style={{ padding: '4px 2px', textAlign: 'left', fontWeight: 600, fontSize: '8px' }}>Match start time:</td>
                                <td style={{ padding: '4px 2px', textAlign: 'left', fontSize: '8px' }}>
                                  {matchStartTime ? matchStartTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—'}
                                </td>
                                <td style={{ padding: '4px 2px', textAlign: 'left', fontWeight: 600, fontSize: '8px' }}>Match end time:</td>
                                <td style={{ padding: '4px 2px', textAlign: 'left', fontSize: '8px' }}>
                                  {matchEndTime ? matchEndTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—'}
                                </td>
                                <td style={{ padding: '4px 2px', textAlign: 'left', fontWeight: 600, fontSize: '8px' }}>Match duration:</td>
                                <td style={{ padding: '4px 2px', textAlign: 'left', fontSize: '8px' }}>
                                  {matchDurationMin > 0 ? `${matchDurationMin} min` : '—'}
                                </td>
                              </tr>
                              <tr>
                                <td style={{ padding: '4px 2px', textAlign: 'left', fontWeight: 600, fontSize: '8px' }}>Winner:</td>
                                <td colSpan="5" style={{ padding: '4px 2px', textAlign: 'left', fontSize: '8px' }}>
                                  {winnerTeamName} ({winnerScore})
                                </td>
                              </tr>
                            </tbody>
                          </table>
                          
                          {/* Post-match signatures */}
                          <div style={{ marginTop: '16px', display: 'flex', gap: '16px', justifyContent: 'space-around' }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: '9px', fontWeight: 600, marginBottom: '4px' }}>
                                {data?.homeTeam?.name || 'Home'} Captain
                              </div>
                              {homeCaptainSignature ? (
                                <div style={{ border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', padding: '4px', minHeight: '40px', background: 'rgba(255,255,255,0.05)' }}>
                                  <img src={homeCaptainSignature} alt="Signature" style={{ maxWidth: '100%', maxHeight: '40px', objectFit: 'contain' }} />
                                </div>
                              ) : (
                                <button
                                  onClick={() => setPostMatchSignature('home-captain')}
                                  style={{
                                    width: '100%',
                                    padding: '8px',
                                    fontSize: '9px',
                                    background: 'rgba(255,255,255,0.1)',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    borderRadius: '4px',
                                    color: 'var(--text)',
                                    cursor: 'pointer'
                                  }}
                                >
                                  Sign
                                </button>
                              )}
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: '9px', fontWeight: 600, marginBottom: '4px' }}>
                                {data?.awayTeam?.name || 'Away'} Captain
                              </div>
                              {awayCaptainSignature ? (
                                <div style={{ border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', padding: '4px', minHeight: '40px', background: 'rgba(255,255,255,0.05)' }}>
                                  <img src={awayCaptainSignature} alt="Signature" style={{ maxWidth: '100%', maxHeight: '40px', objectFit: 'contain' }} />
                                </div>
                              ) : (
                                <button
                                  onClick={() => setPostMatchSignature('away-captain')}
                                  style={{
                                    width: '100%',
                                    padding: '8px',
                                    fontSize: '9px',
                                    background: 'rgba(255,255,255,0.1)',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    borderRadius: '4px',
                                    color: 'var(--text)',
                                    cursor: 'pointer'
                                  }}
                                >
                                  Sign
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    }
                    
                    // Otherwise show set breakdown
                    // Helper to convert set number to Roman numeral
                    const toRoman = (num) => {
                      const romanNumerals = ['I', 'II', 'III', 'IV', 'V']
                      return romanNumerals[num - 1] || num.toString()
                    }
                    
                    // Only show sets that have been played (started or have points)
                    const playedSets = allSets.filter(s => s.homePoints > 0 || s.awayPoints > 0 || s.finished || s.startTime)
                    
                    return (
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '9px' }}>
                        <thead>
                          <tr>
                            <th style={{ padding: '4px 2px', textAlign: 'center', width: '8%' }}></th>
                            <th colSpan="4" style={{ padding: '4px', textAlign: 'center', borderBottom: '1px solid rgba(255,255,255,0.2)', width: '38%' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: '10px', wordBreak: 'break-word' }}>{leftTeamName}</span>
                                <span style={{
                                  padding: '1px 6px',
                                  borderRadius: '3px',
                                  fontSize: '9px',
                                  fontWeight: 700,
                                  background: leftTeamColor,
                                  color: isBrightColor(leftTeamColor) ? '#000' : '#fff'
                                }}>{leftTeamLabel}</span>
                              </div>
                            </th>
                            <th style={{ padding: '4px 2px', fontSize: '8px', width: '8%' }}>Dur</th>
                            <th colSpan="4" style={{ padding: '4px', textAlign: 'center', borderBottom: '1px solid rgba(255,255,255,0.2)', width: '38%' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: '10px', wordBreak: 'break-word' }}>{rightTeamName}</span>
                                <span style={{
                                  padding: '1px 6px',
                                  borderRadius: '3px',
                                  fontSize: '9px',
                                  fontWeight: 700,
                                  background: rightTeamColor, 
                                  color: isBrightColor(rightTeamColor) ? '#000' : '#fff' 
                                }}>{rightTeamLabel}</span>
                              </div>
                            </th>
                          </tr>
                          <tr style={{ borderBottom: '2px solid rgba(255,255,255,0.2)' }}>
                            <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>Set</th>
                            <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>T</th>
                            <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>S</th>
                            <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>W</th>
                            <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>P</th>
                            <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}></th>
                            <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>P</th>
                            <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>W</th>
                            <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>S</th>
                            <th style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>T</th>
                          </tr>
                        </thead>
                        <tbody>
                          {playedSets.map(set => {
                            // Always show from CURRENT left/right perspective
                            const leftPoints = currentLeftTeamKey === 'home' ? set.homePoints : set.awayPoints
                            const rightPoints = currentRightTeamKey === 'home' ? set.homePoints : set.awayPoints
                            
                            // Calculate timeouts for current left/right teams
                            const leftTimeouts = (data?.events || []).filter(e => 
                              e.type === 'timeout' && e.setIndex === set.index && e.payload?.team === currentLeftTeamKey
                            ).length
                            const rightTimeouts = (data?.events || []).filter(e => 
                              e.type === 'timeout' && e.setIndex === set.index && e.payload?.team === currentRightTeamKey
                            ).length
                            
                            // Calculate substitutions for current left/right teams
                            const leftSubs = (data?.events || []).filter(e => 
                              e.type === 'substitution' && e.setIndex === set.index && e.payload?.team === currentLeftTeamKey
                            ).length
                            const rightSubs = (data?.events || []).filter(e => 
                              e.type === 'substitution' && e.setIndex === set.index && e.payload?.team === currentRightTeamKey
                            ).length
                            
                            // Determine winner for current left/right teams
                            const leftWon = leftPoints > rightPoints ? 1 : 0
                            const rightWon = rightPoints > leftPoints ? 1 : 0
                            
                            // Calculate set duration
                            let duration = ''
                            if (set.startTime && set.endTime) {
                              const start = new Date(set.startTime)
                              const end = new Date(set.endTime)
                              const durationMs = end - start
                              const durationMin = Math.floor(durationMs / 60000)
                              duration = `${durationMin}'`
                            }
                            
                            return (
                              <tr key={set.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                                <td style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 600, fontSize: '8px' }}>{toRoman(set.index)}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center', fontSize: '8px' }}>{leftTimeouts || 0}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center', fontSize: '8px' }}>{leftSubs || 0}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center', fontSize: '8px' }}>{leftWon}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center', fontSize: '8px' }}>{leftPoints}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center', fontSize: '8px', color: 'var(--muted)' }}>{duration}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center', fontSize: '8px' }}>{rightPoints}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center', fontSize: '8px' }}>{rightWon}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center', fontSize: '8px' }}>{rightSubs || 0}</td>
                                <td style={{ padding: '4px 2px', textAlign: 'center', fontSize: '8px' }}>{rightTimeouts || 0}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )
                  })()}
                </div>
              </div>
            </section>
          </div>
        </Modal>
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
        onSave={async () => {
          const teamKey = lineupModal.team
          setLineupModal(null)
          // Check if captain is on court after lineup is saved
          setTimeout(() => {
            checkAndRequestCaptainOnCourt(teamKey)
          }, 100)
        }}
      />}
      
      {playerActionMenu && (() => {
        // Get element position - use stored coordinates if available
        let menuStyle
        if (playerActionMenu.x !== undefined && playerActionMenu.y !== undefined) {
          menuStyle = {
            position: 'fixed',
            left: `${playerActionMenu.x}px`,
            top: `${playerActionMenu.y}px`,
            transform: 'translateY(-50%)',
            zIndex: 1000
          }
        } else {
          const rect = playerActionMenu.element?.getBoundingClientRect?.()
          menuStyle = rect ? {
            position: 'fixed',
            left: `${rect.right + 30}px`,
            top: `${rect.top + rect.height / 2}px`,
            transform: 'translateY(-50%)',
            zIndex: 1000
          } : {
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 1000
          }
        }

        // Get available substitutes for this player
        const { team, position, playerNumber } = playerActionMenu
        const availableSubs = playerActionMenu.canSubstitute ? getAvailableSubstitutes(team, playerNumber) : []

        // Get sanction availability
        const teamWarning = teamHasFormalWarning(team)
        const hasWarning = playerHasSanctionType(team, playerNumber, 'warning')
        const hasPenalty = playerHasSanctionType(team, playerNumber, 'penalty')
        const hasExpulsion = playerHasSanctionType(team, playerNumber, 'expulsion')
        const canGetWarning = !hasWarning && !teamWarning
        const canGetPenalty = !hasPenalty
        const canGetExpulsion = !hasExpulsion

        const showSanctionConfirmFromMenu = (sanctionType) => {
          setPlayerActionMenu(null)
          setCourtSubExpanded(false)
          setCourtSanctionExpanded(false)
          setSanctionConfirmModal({
            team,
            type: 'player',
            playerNumber,
            position,
            sanctionType
          })
        }

        const handleSubFromMenu = (subPlayer) => {
          setPlayerActionMenu(null)
          setCourtSubExpanded(false)
          setCourtSanctionExpanded(false)
          // Open substitution confirmation modal (which properly creates both lineup and substitution events)
          setSubstitutionConfirm({
            team,
            position,
            playerOut: playerNumber,
            playerIn: subPlayer.number
          })
        }

        return (
          <>
            {/* Backdrop to close menu on click outside */}
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
              onClick={() => { setPlayerActionMenu(null); setCourtSubExpanded(false); setCourtSanctionExpanded(false) }}
            />
            {/* Action Menu */}
            <div style={menuStyle} className="modal-wrapper-roll-down">
              <div
                data-player-action-menu
                style={{
                  background: 'rgba(15, 23, 42, 0.95)',
                  border: '2px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  padding: '8px',
                  minWidth: '140px',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px'
                }}
              >
                <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--muted)', textAlign: 'center', marginBottom: '4px' }}>
                  # {playerNumber}
                </div>
                {/* Substitution - expandable */}
                {playerActionMenu.canSubstitute && availableSubs.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <button
                      onClick={() => setCourtSubExpanded(!courtSubExpanded)}
                      style={{
                        padding: '8px 12px',
                        fontSize: '12px',
                        fontWeight: 600,
                        background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                        color: '#000',
                        border: '1px solid rgba(0, 0, 0, 0.2)',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'all 0.2s',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '6px',
                        width: '100%'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'linear-gradient(135deg, #4ade80, #22c55e)'
                        e.currentTarget.style.transform = 'scale(1.02)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'linear-gradient(135deg, #22c55e, #16a34a)'
                        e.currentTarget.style.transform = 'scale(1)'
                      }}
                    >
                      <span>Substitution</span>
                      <span style={{ fontSize: '14px', lineHeight: '1', transform: courtSubExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▼</span>
                    </button>
                    {courtSubExpanded && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
                        {availableSubs.map(sub => (
                          <button
                            key={sub.number}
                            onClick={() => handleSubFromMenu(sub)}
                            style={{
                              padding: '6px 10px',
                              fontSize: '12px',
                              fontWeight: 700,
                              background: 'rgba(34, 197, 94, 0.2)',
                              color: '#22c55e',
                              border: '1px solid rgba(34, 197, 94, 0.4)',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              transition: 'all 0.2s',
                              minWidth: '40px'
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = 'rgba(34, 197, 94, 0.4)'
                              e.currentTarget.style.borderColor = 'rgba(34, 197, 94, 0.6)'
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = 'rgba(34, 197, 94, 0.2)'
                              e.currentTarget.style.borderColor = 'rgba(34, 197, 94, 0.4)'
                            }}
                          >
                            {sub.number}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {/* Libero - direct button */}
                {playerActionMenu.canEnterLibero && (
                  <button
                    onClick={openLiberoFromMenu}
                    style={{
                      padding: '8px 12px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: '#FFF8E7',
                      color: '#000',
                      border: '1px solid rgba(0, 0, 0, 0.2)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.2s',
                      width: '100%'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = '#fff4d6'
                      e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.3)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = '#FFF8E7'
                      e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.2)'
                    }}
                  >
                    Libero
                  </button>
                )}
                {/* Sanction - expandable */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <button
                    onClick={() => setCourtSanctionExpanded(!courtSanctionExpanded)}
                    style={{
                      padding: '8px 12px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: '#000',
                      color: '#fff',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '6px',
                      width: '100%'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = '#1a1a1a'
                      e.currentTarget.style.transform = 'scale(1.02)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = '#000'
                      e.currentTarget.style.transform = 'scale(1)'
                    }}
                  >
                    <span>Sanction</span>
                    <span style={{ fontSize: '14px', lineHeight: '1', transform: courtSanctionExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▼</span>
                  </button>
                  {courtSanctionExpanded && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                      <button
                        onClick={() => showSanctionConfirmFromMenu('warning')}
                        disabled={!canGetWarning}
                        style={{
                          padding: '6px 10px',
                          fontSize: '11px',
                          fontWeight: 600,
                          background: canGetWarning ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)',
                          color: canGetWarning ? 'var(--text)' : 'var(--muted)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '4px',
                          cursor: canGetWarning ? 'pointer' : 'not-allowed',
                          textAlign: 'left',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          opacity: canGetWarning ? 1 : 0.5
                        }}
                      >
                        <div className="sanction-card yellow" style={{ flexShrink: 0, width: '20px', height: '26px' }}></div>
                        <span>Warning</span>
                      </button>
                      <button
                        onClick={() => showSanctionConfirmFromMenu('penalty')}
                        disabled={!canGetPenalty}
                        style={{
                          padding: '6px 10px',
                          fontSize: '11px',
                          fontWeight: 600,
                          background: canGetPenalty ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)',
                          color: canGetPenalty ? 'var(--text)' : 'var(--muted)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '4px',
                          cursor: canGetPenalty ? 'pointer' : 'not-allowed',
                          textAlign: 'left',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          opacity: canGetPenalty ? 1 : 0.5
                        }}
                      >
                        <div className="sanction-card red" style={{ flexShrink: 0, width: '20px', height: '26px' }}></div>
                        <span>Penalty</span>
                      </button>
                      <button
                        onClick={() => showSanctionConfirmFromMenu('expulsion')}
                        disabled={!canGetExpulsion}
                        style={{
                          padding: '6px 10px',
                          fontSize: '11px',
                          fontWeight: 600,
                          background: canGetExpulsion ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)',
                          color: canGetExpulsion ? 'var(--text)' : 'var(--muted)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '4px',
                          cursor: canGetExpulsion ? 'pointer' : 'not-allowed',
                          textAlign: 'left',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          opacity: canGetExpulsion ? 1 : 0.5
                        }}
                      >
                        <div className="sanction-card combo" style={{ flexShrink: 0, width: '24px', height: '26px' }}></div>
                        <span>Expulsion</span>
                      </button>
                      <button
                        onClick={() => showSanctionConfirmFromMenu('disqualification')}
                        style={{
                          padding: '6px 10px',
                          fontSize: '11px',
                          fontWeight: 600,
                          background: 'rgba(255, 255, 255, 0.05)',
                          color: 'var(--text)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          textAlign: 'left',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px'
                        }}
                      >
                        <div className="sanction-cards-separate" style={{ flexShrink: 0, display: 'flex', gap: '2px' }}>
                          <div className="sanction-card yellow" style={{ width: '16px', height: '22px' }}></div>
                          <div className="sanction-card red" style={{ width: '16px', height: '22px' }}></div>
                        </div>
                        <span>Disqualification</span>
                      </button>
                    </div>
                  )}
                </div>
                {/* Injury - direct button */}
                <button
                  onClick={openInjuryFromMenu}
                  style={{
                    padding: '8px 12px',
                    fontSize: '12px',
                    fontWeight: 600,
                    background: '#dc2626',
                    color: '#fff',
                    border: '2px solid #991b1b',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.2s',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '6px',
                    position: 'relative',
                    width: '100%'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#ef4444'
                    e.currentTarget.style.transform = 'scale(1.02)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = '#dc2626'
                    e.currentTarget.style.transform = 'scale(1)'
                  }}
                >
                  <span>Injury</span>
                  <span style={{
                    fontSize: '18px',
                    lineHeight: '1',
                    fontWeight: 700,
                    color: '#fff',
                    textShadow: '0 1px 2px rgba(0,0,0,0.3)'
                  }}>✚</span>
                </button>
              </div>
            </div>
          </>
        )
      })()}
      
      {substitutionDropdown && (() => {
        const teamKey = substitutionDropdown.team
        const teamData = teamKey === 'home' ? data?.homeTeam : data?.awayTeam
        
        // Check if substitution is legal
        const isLegal = isSubstitutionLegal(teamKey, substitutionDropdown.playerNumber)
        
        // Get available substitutes - use exceptional if flagged, otherwise check legal status
        const isExceptional = substitutionDropdown.isExceptional === true
        const availableSubstitutes = isExceptional
          ? getAvailableExceptionalSubstitutes(teamKey, substitutionDropdown.playerNumber)
          : getAvailableSubstitutes(teamKey, substitutionDropdown.playerNumber, !isLegal)
        
        // Check if player is expelled or disqualified
        const playerSanctions = data?.events?.filter(e => 
          e.type === 'sanction' && 
          e.payload?.team === teamKey &&
          e.payload?.playerNumber === substitutionDropdown.playerNumber &&
          (e.payload?.type === 'expulsion' || e.payload?.type === 'disqualification')
        ) || []
        const isExpelled = playerSanctions.some(s => s.payload?.type === 'expulsion')
        const isDisqualified = playerSanctions.some(s => s.payload?.type === 'disqualification')
        
        // Get element position - use stored coordinates if available, otherwise try to find element
        let dropdownStyle
        if (substitutionDropdown.x !== undefined && substitutionDropdown.y !== undefined) {
          dropdownStyle = {
            position: 'fixed',
            left: `${substitutionDropdown.x}px`,
            top: `${substitutionDropdown.y}px`,
            transform: 'translateY(-50%)',
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
            left: `${rect.right + 30}px`,
            top: `${rect.top + rect.height / 2}px`,
            transform: 'translateY(-50%)',
            zIndex: 1000
          } : {
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 1000
          }
        }
        
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
                setSubstitutionDropdown(null)
                setLiberoDropdown(null)
                setLiberoInDropdown(null)
                setSanctionDropdown(null)
                setInjuryDropdown(null)
                setPlayerActionMenu(null)
              }}
            />
            {/* Dropdown */}
            <div style={dropdownStyle} className="modal-wrapper-roll-down">
              <div
                data-substitution-dropdown
                style={{
                  background: 'rgba(15, 23, 42, 0.95)',
                  border: '2px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  padding: '8px',
                  minWidth: '80px',
                  maxWidth: '100px',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)'
                }}
              >
              <div style={{ marginBottom: '8px', fontSize: '12px', fontWeight: 600, color: 'var(--text)', textAlign: 'center', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', paddingBottom: '8px' }}>
                {isExceptional ? 'Exceptional Substitution' : 'Substitution'}
              </div>
              <div style={{ marginBottom: '8px', fontSize: '11px', color: 'var(--muted)', textAlign: 'center' }}>
                # {substitutionDropdown.playerNumber} out
              </div>
              {isExceptional && availableSubstitutes.length > 0 && (
                <div style={{ marginBottom: '8px', padding: '4px', textAlign: 'center', color: '#facc15', fontSize: '10px', fontWeight: 600, background: 'rgba(234, 179, 8, 0.15)', border: '1px solid rgba(234, 179, 8, 0.3)', borderRadius: '4px' }}>
                  Exceptional
                </div>
              )}
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
        // Also filter out liberos that are unable to play
        const liberos = liberoOnCourt ? [] : allLiberos.filter(libero => {
          return !isLiberoUnable(teamKey, libero.number)
        })
        
        // Get element position - use stored coordinates if available, otherwise try to find element
        let dropdownStyle
        if (liberoDropdown.x !== undefined && liberoDropdown.y !== undefined) {
          dropdownStyle = {
            position: 'fixed',
            left: `${liberoDropdown.x}px`,
            top: `${liberoDropdown.y}px`,
            transform: 'translateY(-50%)',
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
            left: `${rect.right + 30}px`,
            top: `${rect.top + rect.height / 2}px`,
            transform: 'translateY(-50%)',
            zIndex: 1000
          } : {
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 1000
          }
        }
        
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
                setSubstitutionDropdown(null)
                setLiberoDropdown(null)
                setLiberoInDropdown(null)
                setSanctionDropdown(null)
                setInjuryDropdown(null)
                setPlayerActionMenu(null)
              }}
            />
            {/* Dropdown */}
            <div style={dropdownStyle} className="modal-wrapper-roll-down">
              <div
                data-libero-dropdown
                style={{
                  background: '#FFF8E7',
                  border: '2px solid rgba(0, 0, 0, 0.2)',
                  borderRadius: '8px',
                  padding: '8px',
                  minWidth: '80px',
                  maxWidth: '100px',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)'
                }}
              >
              <div style={{ marginBottom: '8px', fontSize: '12px', fontWeight: 600, color: '#000', textAlign: 'center', borderBottom: '1px solid rgba(0, 0, 0, 0.1)', paddingBottom: '8px' }}>
                Libero
              </div>
              <div style={{ marginBottom: '8px', fontSize: '11px', color: '#666', textAlign: 'center' }}>
                # {liberoDropdown.playerNumber} out
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
            </div>
          </>
        )
      })()}
      
      {liberoInDropdown && (() => {
        const teamKey = liberoInDropdown.team
        const { playersOnCourt } = getTeamLineupState(teamKey)
        
        // Get eligible players (I if not serving, II, III)
        const currentServe = getCurrentServe()
        const teamServes = currentServe === teamKey
        const eligiblePlayers = playersOnCourt.filter(p => {
          if (p.position === 'I') return !teamServes // Position I only if not serving
          return p.position === 'II' || p.position === 'III'
        })
        
        // Get dropdown position
        const dropdownStyle = {
          position: 'fixed',
          left: `${liberoInDropdown.x}px`,
          top: `${liberoInDropdown.y}px`,
          transform: 'translateX(-50%)',
          zIndex: 1000
        }
        
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
                setLiberoInDropdown(null)
                setSubstitutionDropdown(null)
                setLiberoDropdown(null)
                setSanctionDropdown(null)
                setInjuryDropdown(null)
                setPlayerActionMenu(null)
              }}
            />
            {/* Dropdown */}
            <div style={dropdownStyle} className="modal-wrapper-roll-down">
              <div
                data-libero-in-dropdown
                style={{
                  background: '#FFF8E7',
                  border: '2px solid rgba(0, 0, 0, 0.2)',
                  borderRadius: '8px',
                  padding: '8px',
                  minWidth: '120px',
                  maxWidth: '150px',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)'
                }}
              >
                <div style={{ marginBottom: '8px', fontSize: '12px', fontWeight: 600, color: '#000', textAlign: 'center', borderBottom: '1px solid rgba(0, 0, 0, 0.1)', paddingBottom: '8px' }}>
                  Libero In
                </div>
                {eligiblePlayers.length === 0 ? (
                  <div style={{ padding: '8px', textAlign: 'center', color: '#666', fontSize: '11px' }}>
                    No eligible players
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {eligiblePlayers.map(player => (
                      <button
                        key={`${player.position}-${player.number}`}
                        onClick={() => handleLiberoInPlayerSelect(player.position, player.number)}
                        style={{
                          padding: '6px 8px',
                          fontSize: '12px',
                          fontWeight: 700,
                          background: 'rgba(0, 0, 0, 0.05)',
                          color: '#000',
                          border: '1px solid rgba(0, 0, 0, 0.1)',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          textAlign: 'center',
                          transition: 'all 0.2s',
                          width: '100%',
                          minHeight: '32px',
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
                        <span style={{ fontSize: '10px', opacity: 0.7 }}>Pos {player.position}:</span>
                        <span>#{player.number}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )
      })()}
      
      {sanctionDropdown && (() => {
        // Get element position - use stored coordinates if available
        let dropdownStyle
        if (sanctionDropdown.x !== undefined && sanctionDropdown.y !== undefined) {
          dropdownStyle = {
            position: 'fixed',
            left: `${sanctionDropdown.x}px`,
            top: `${sanctionDropdown.y}px`,
            transform: 'translateY(-50%)',
            zIndex: 1000
          }
        } else {
          const rect = sanctionDropdown.element?.getBoundingClientRect?.()
          dropdownStyle = rect ? {
            position: 'fixed',
            left: `${rect.right + 30}px`,
            top: `${rect.top + rect.height / 2}px`,
            transform: 'translateY(-50%)',
            zIndex: 1000
          } : {
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 1000
          }
        }
        
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
              onClick={cancelSanction}
            />
            {/* Dropdown */}
            <div style={dropdownStyle} className="modal-wrapper-roll-up">
              <div
                data-sanction-dropdown
                style={{
                  background: 'rgba(15, 23, 42, 0.95)',
                  border: '2px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  padding: '8px',
                  minWidth: '160px',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)'
                }}
              >
              <div style={{ marginBottom: '8px', fontSize: '11px', fontWeight: 600, color: 'var(--text)', textAlign: 'center', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', paddingBottom: '6px' }}>
                {(() => {
                  const { type, playerNumber, role } = sanctionDropdown
                  if (type === 'official') {
                    // Map role to abbreviation
                    const roleAbbr = role === 'Coach' ? 'C' : 
                                     role === 'Assistant Coach 1' ? 'AC1' :
                                     role === 'Assistant Coach 2' ? 'AC2' :
                                     role === 'Physiotherapist' ? 'P' :
                                     role === 'Medic' ? 'M' : role
                    return `Sanction for ${roleAbbr}`
                  } else if (type === 'bench' && playerNumber) {
                    return `Actions for # ${playerNumber}`
                  } else if (playerNumber) {
                    return `Sanction for ${playerNumber}`
                  } else {
                    return 'Sanction'
                  }
                })()}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {(() => {
                  const teamKey = sanctionDropdown.team
                  const playerNumber = sanctionDropdown.playerNumber
                  const teamWarning = teamHasFormalWarning(teamKey)

                  // Check if player has each specific sanction type (for back-sanctioning rules)
                  const hasWarning = playerNumber ? playerHasSanctionType(teamKey, playerNumber, 'warning') : false
                  const hasPenalty = playerNumber ? playerHasSanctionType(teamKey, playerNumber, 'penalty') : false
                  const hasExpulsion = playerNumber ? playerHasSanctionType(teamKey, playerNumber, 'expulsion') : false
                  const hasDisqualification = playerNumber ? playerHasSanctionType(teamKey, playerNumber, 'disqualification') : false

                  // Determine which sanctions are available
                  // Rule: A player cannot get the same sanction type twice
                  // Exception: Warning can only be given if team hasn't been warned (player can have other sanctions)
                  const canGetWarning = !hasWarning && !teamWarning
                  // Penalty: can be given if player doesn't already have a penalty (back-sanctioning allowed)
                  const canGetPenalty = !hasPenalty
                  // Expulsion: can be given if player doesn't already have an expulsion (back-sanctioning allowed)
                  const canGetExpulsion = !hasExpulsion
                  // Disqualification: can be given if player doesn't already have a disqualification (back-sanctioning allowed)
                  const canGetDisqualification = !hasDisqualification

                  return (
                    <>
                      <button
                        onClick={() => showSanctionConfirm('warning')}
                        disabled={!canGetWarning}
                        style={{
                          padding: '4px 8px',
                          fontSize: '11px',
                          fontWeight: 600,
                          background: canGetWarning ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)',
                          color: canGetWarning ? 'var(--text)' : 'var(--muted)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '4px',
                          cursor: canGetWarning ? 'pointer' : 'not-allowed',
                          textAlign: 'left',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          transition: 'all 0.2s',
                          opacity: canGetWarning ? 1 : 0.5
                        }}
                        onMouseEnter={(e) => {
                          if (canGetWarning) {
                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
                            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (canGetWarning) {
                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                          }
                        }}
                      >
                        <div className="sanction-card yellow" style={{ flexShrink: 0, width: '24px', height: '32px' }}></div>
                        <span>Warning{!canGetWarning && (teamWarning ? ' (Team has warning)' : ' (Already sanctioned)')}</span>
                      </button>
                      <button
                        onClick={() => showSanctionConfirm('penalty')}
                        disabled={!canGetPenalty}
                        style={{
                          padding: '4px 8px',
                          fontSize: '11px',
                          fontWeight: 600,
                          background: canGetPenalty ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)',
                          color: canGetPenalty ? 'var(--text)' : 'var(--muted)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '4px',
                          cursor: canGetPenalty ? 'pointer' : 'not-allowed',
                          textAlign: 'left',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          transition: 'all 0.2s',
                          opacity: canGetPenalty ? 1 : 0.5
                        }}
                        onMouseEnter={(e) => {
                          if (canGetPenalty) {
                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
                            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (canGetPenalty) {
                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                          }
                        }}
                      >
                        <div className="sanction-card red" style={{ flexShrink: 0, width: '24px', height: '32px' }}></div>
                        <span>Penalty{!canGetPenalty && ' (Already sanctioned)'}</span>
                      </button>
                      <button
                        onClick={() => showSanctionConfirm('expulsion')}
                        disabled={!canGetExpulsion}
                        style={{
                          padding: '4px 8px',
                          fontSize: '11px',
                          fontWeight: 600,
                          background: canGetExpulsion ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)',
                          color: canGetExpulsion ? 'var(--text)' : 'var(--muted)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '4px',
                          cursor: canGetExpulsion ? 'pointer' : 'not-allowed',
                          textAlign: 'left',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          transition: 'all 0.2s',
                          opacity: canGetExpulsion ? 1 : 0.5
                        }}
                        onMouseEnter={(e) => {
                          if (canGetExpulsion) {
                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
                            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (canGetExpulsion) {
                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                          }
                        }}
                      >
                        <div className="sanction-card combo" style={{ flexShrink: 0, width: '28px', height: '32px' }}></div>
                        <span>Expulsion{!canGetExpulsion && ' (Already sanctioned)'}</span>
                      </button>
                      <button
                        onClick={() => showSanctionConfirm('disqualification')}
                        disabled={false}
                        style={{
                          padding: '4px 8px',
                          fontSize: '11px',
                          fontWeight: 600,
                          background: 'rgba(255, 255, 255, 0.05)',
                          color: 'var(--text)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          textAlign: 'left',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          transition: 'all 0.2s'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
                          e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)'
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                          e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                        }}
                      >
                        <div className="sanction-cards-separate" style={{ flexShrink: 0 }}>
                          <div className="sanction-card yellow" style={{ width: '20px', height: '28px' }}></div>
                          <div className="sanction-card red" style={{ width: '20px', height: '28px' }}></div>
                        </div>
                        <span>Disqualification</span>
                      </button>
                    </>
                  )
                })()}
              </div>
              </div>
            </div>
          </>
        )
      })()}

      {/* Bench Player Action Menu */}
      {benchPlayerActionMenu && (() => {
        // Get element position - use stored coordinates if available
        let menuStyle
        if (benchPlayerActionMenu.x !== undefined && benchPlayerActionMenu.y !== undefined) {
          menuStyle = {
            position: 'fixed',
            left: `${benchPlayerActionMenu.x}px`,
            top: `${benchPlayerActionMenu.y}px`,
            transform: 'translateY(-50%)',
            zIndex: 1000
          }
        } else {
          const rect = benchPlayerActionMenu.element?.getBoundingClientRect?.()
          menuStyle = rect ? {
            position: 'fixed',
            left: `${rect.right + 30}px`,
            top: `${rect.top + rect.height / 2}px`,
            transform: 'translateY(-50%)',
            zIndex: 1000
          } : {
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 1000
          }
        }

        const { team, playerNumber, canSubstitute, courtPlayerToSwapWith, neverPlayed } = benchPlayerActionMenu

        // For "never played" bench players, get available court players to substitute
        // Filter out liberos - cannot substitute for a libero on court
        const availableCourtPlayers = []
        if (neverPlayed && canSubstitute) {
          const currentLineup = getCurrentLineup(team)
          const liberoOnCourt = getLiberoOnCourt(team)
          const teamPlayers = team === 'home' ? data?.homePlayers : data?.awayPlayers
          if (currentLineup) {
            Object.entries(currentLineup).forEach(([pos, num]) => {
              if (num) {
                // Check if this court player can be substituted
                const canBeSub = canPlayerBeSubstituted(team, num)
                // Check if this is a libero (cannot substitute for libero)
                const isLibero = teamPlayers?.some(p =>
                  String(p.number) === String(num) && (p.role === 'libero1' || p.role === 'libero2')
                )
                // Also check if current libero is on court at this position
                const isLiberoOnCourt = liberoOnCourt && String(liberoOnCourt.liberoNumber) === String(num)
                if (canBeSub && !isLibero && !isLiberoOnCourt) {
                  availableCourtPlayers.push({ position: pos, number: num })
                }
              }
            })
          }
        }

        
        return (
          <>
            {/* Backdrop to close menu on click outside */}
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
              onClick={() => { setBenchPlayerActionMenu(null); setBenchSubExpanded(false); setBenchSanctionExpanded(false) }}
            />
            {/* Action Menu */}
            <div style={menuStyle} className="modal-wrapper-roll-down">
              <div
                data-bench-player-action-menu
                style={{
                  background: 'rgba(15, 23, 42, 0.95)',
                  border: '2px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  padding: '8px',
                  minWidth: '140px',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px'
                }}
              >
                <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--muted)', textAlign: 'center', marginBottom: '4px' }}>
                  # {playerNumber}
                </div>
                {/* Substitution Button - for returning players */}
                {courtPlayerToSwapWith && (
                  <button
                    onClick={() => {
                      if (canSubstitute && courtPlayerToSwapWith) {
                        setBenchPlayerActionMenu(null)
                        // Go directly to substitution confirmation modal
                        setSubstitutionConfirm({
                          team,
                          position: courtPlayerToSwapWith.position,
                          playerOut: courtPlayerToSwapWith.number,
                          playerIn: playerNumber
                        })
                      }
                    }}
                    disabled={!canSubstitute}
                    style={{
                      padding: '8px 12px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: canSubstitute ? 'linear-gradient(135deg, #22c55e, #16a34a)' : 'rgba(255, 255, 255, 0.05)',
                      color: canSubstitute ? '#000' : 'var(--muted)',
                      border: canSubstitute ? '1px solid rgba(0, 0, 0, 0.2)' : '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '6px',
                      cursor: canSubstitute ? 'pointer' : 'not-allowed',
                      textAlign: 'left',
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '6px',
                      width: '100%',
                      opacity: canSubstitute ? 1 : 0.5
                    }}
                    onMouseEnter={(e) => {
                      if (canSubstitute) {
                        e.currentTarget.style.background = 'linear-gradient(135deg, #4ade80, #22c55e)'
                      e.currentTarget.style.transform = 'scale(1.02)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (canSubstitute) {
                      e.currentTarget.style.background = 'linear-gradient(135deg, #22c55e, #16a34a)'
                      e.currentTarget.style.transform = 'scale(1)'
                    }
                  }}
                >
                  <span>Substitution</span>
                  <span style={{ fontSize: '14px', lineHeight: '1' }}>⇅</span>
                </button>
                )}
                {/* Substitution button with expandable list - for players who never played */}
                {neverPlayed && availableCourtPlayers.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <button
                      onClick={() => setBenchSubExpanded(!benchSubExpanded)}
                      style={{
                        padding: '8px 12px',
                        fontSize: '12px',
                        fontWeight: 600,
                        background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                        color: '#000',
                        border: '1px solid rgba(0, 0, 0, 0.2)',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'all 0.2s',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '6px',
                        width: '100%'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'linear-gradient(135deg, #4ade80, #22c55e)'
                        e.currentTarget.style.transform = 'scale(1.02)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'linear-gradient(135deg, #22c55e, #16a34a)'
                        e.currentTarget.style.transform = 'scale(1)'
                      }}
                    >
                      <span>Substitution</span>
                      <span style={{ fontSize: '14px', lineHeight: '1', transform: benchSubExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▼</span>
                    </button>
                    {benchSubExpanded && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
                        {availableCourtPlayers.map(cp => (
                          <button
                            key={cp.position}
                            onClick={() => {
                              setBenchPlayerActionMenu(null)
                              setBenchSubExpanded(false)
                              // Go directly to substitution confirmation modal
                              setSubstitutionConfirm({
                                team,
                                position: cp.position,
                                playerOut: cp.number,
                                playerIn: playerNumber
                              })
                            }}
                            style={{
                              padding: '6px 10px',
                              fontSize: '12px',
                              fontWeight: 700,
                              background: 'rgba(34, 197, 94, 0.2)',
                              color: '#22c55e',
                              border: '1px solid rgba(34, 197, 94, 0.4)',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              transition: 'all 0.2s',
                              minWidth: '40px'
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = 'rgba(34, 197, 94, 0.4)'
                              e.currentTarget.style.borderColor = 'rgba(34, 197, 94, 0.6)'
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = 'rgba(34, 197, 94, 0.2)'
                              e.currentTarget.style.borderColor = 'rgba(34, 197, 94, 0.4)'
                            }}
                          >
                            {cp.number}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {/* Sanction - expandable */}
                {(() => {
                  // Get sanction availability for bench player
                  const teamWarning = teamHasFormalWarning(team)
                  const hasWarning = playerHasSanctionType(team, playerNumber, 'warning')
                  const hasPenalty = playerHasSanctionType(team, playerNumber, 'penalty')
                  const hasExpulsion = playerHasSanctionType(team, playerNumber, 'expulsion')
                  const canGetWarning = !hasWarning && !teamWarning
                  const canGetPenalty = !hasPenalty
                  const canGetExpulsion = !hasExpulsion

                  const showSanctionConfirmFromBenchMenu = (sanctionType) => {
                    setBenchPlayerActionMenu(null)
                    setBenchSubExpanded(false)
                    setBenchSanctionExpanded(false)
                    setSanctionConfirmModal({
                      team,
                      type: 'bench',
                      playerNumber,
                      sanctionType
                    })
                  }

                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <button
                        onClick={() => setBenchSanctionExpanded(!benchSanctionExpanded)}
                        style={{
                          padding: '8px 12px',
                          fontSize: '12px',
                          fontWeight: 600,
                          background: '#000',
                          color: '#fff',
                          border: '1px solid rgba(255, 255, 255, 0.2)',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          textAlign: 'left',
                          transition: 'all 0.2s',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '6px',
                          width: '100%'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = '#1a1a1a'
                          e.currentTarget.style.transform = 'scale(1.02)'
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = '#000'
                          e.currentTarget.style.transform = 'scale(1)'
                        }}
                      >
                        <span>Sanction</span>
                        <span style={{ fontSize: '14px', lineHeight: '1', transform: benchSanctionExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▼</span>
                      </button>
                      {benchSanctionExpanded && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                          <button
                            onClick={() => showSanctionConfirmFromBenchMenu('warning')}
                            disabled={!canGetWarning}
                            style={{
                              padding: '6px 10px',
                              fontSize: '11px',
                              fontWeight: 600,
                              background: canGetWarning ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)',
                              color: canGetWarning ? 'var(--text)' : 'var(--muted)',
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                              borderRadius: '4px',
                              cursor: canGetWarning ? 'pointer' : 'not-allowed',
                              textAlign: 'left',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              opacity: canGetWarning ? 1 : 0.5
                            }}
                          >
                            <div className="sanction-card yellow" style={{ flexShrink: 0, width: '20px', height: '26px' }}></div>
                            <span>Warning</span>
                          </button>
                          <button
                            onClick={() => showSanctionConfirmFromBenchMenu('penalty')}
                            disabled={!canGetPenalty}
                            style={{
                              padding: '6px 10px',
                              fontSize: '11px',
                              fontWeight: 600,
                              background: canGetPenalty ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)',
                              color: canGetPenalty ? 'var(--text)' : 'var(--muted)',
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                              borderRadius: '4px',
                              cursor: canGetPenalty ? 'pointer' : 'not-allowed',
                              textAlign: 'left',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              opacity: canGetPenalty ? 1 : 0.5
                            }}
                          >
                            <div className="sanction-card red" style={{ flexShrink: 0, width: '20px', height: '26px' }}></div>
                            <span>Penalty</span>
                          </button>
                          <button
                            onClick={() => showSanctionConfirmFromBenchMenu('expulsion')}
                            disabled={!canGetExpulsion}
                            style={{
                              padding: '6px 10px',
                              fontSize: '11px',
                              fontWeight: 600,
                              background: canGetExpulsion ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)',
                              color: canGetExpulsion ? 'var(--text)' : 'var(--muted)',
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                              borderRadius: '4px',
                              cursor: canGetExpulsion ? 'pointer' : 'not-allowed',
                              textAlign: 'left',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              opacity: canGetExpulsion ? 1 : 0.5
                            }}
                          >
                            <div className="sanction-card combo" style={{ flexShrink: 0, width: '24px', height: '26px' }}></div>
                            <span>Expulsion</span>
                          </button>
                          <button
                            onClick={() => showSanctionConfirmFromBenchMenu('disqualification')}
                            style={{
                              padding: '6px 10px',
                              fontSize: '11px',
                              fontWeight: 600,
                              background: 'rgba(255, 255, 255, 0.05)',
                              color: 'var(--text)',
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              textAlign: 'left',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px'
                            }}
                          >
                            <div className="sanction-cards-separate" style={{ flexShrink: 0, display: 'flex', gap: '2px' }}>
                              <div className="sanction-card yellow" style={{ width: '16px', height: '22px' }}></div>
                              <div className="sanction-card red" style={{ width: '16px', height: '22px' }}></div>
                            </div>
                            <span>Disqualification</span>
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })()}
                {/* Injury Button */}
                <button
                  onClick={async () => {
                    // For bench player injury, just add a remark (no substitution needed since they're not on court)
                    const remarks = data?.match?.remarks || ''
                    const timestamp = new Date().toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
                    const teamName = team === 'home' ? (data?.homeTeam?.name || 'Home') : (data?.awayTeam?.name || 'Away')
                    const newRemark = `[${timestamp}] Injury: ${teamName} #${playerNumber} (bench)`
                    const updatedRemarks = remarks ? `${remarks}\n${newRemark}` : newRemark

                    await db.matches.update(matchId, { remarks: updatedRemarks })
                    setBenchPlayerActionMenu(null)
                    setConfirmMessage(`Injury recorded for #${playerNumber}`)
                  }}
                  style={{
                    padding: '8px 12px',
                    fontSize: '12px',
                    fontWeight: 600,
                    background: '#dc2626',
                    color: '#fff',
                    border: '2px solid #991b1b',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.2s',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '6px',
                    position: 'relative',
                    width: '100%'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#ef4444'
                    e.currentTarget.style.transform = 'scale(1.02)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = '#dc2626'
                    e.currentTarget.style.transform = 'scale(1)'
                  }}
                >
                  <span>Injury</span>
                  <span style={{
                    fontSize: '18px',
                    lineHeight: '1',
                    fontWeight: 700,
                    color: '#fff',
                    textShadow: '0 1px 2px rgba(0,0,0,0.3)'
                  }}>✚</span>
                </button>
              </div>
            </div>
          </>
        )
      })()}


      {injuryDropdown && (() => {
        // Get element position - use stored coordinates if available
        let dropdownStyle
        if (injuryDropdown.x !== undefined && injuryDropdown.y !== undefined) {
          dropdownStyle = {
            position: 'fixed',
            left: `${injuryDropdown.x}px`,
            top: `${injuryDropdown.y}px`,
            transform: 'translateY(-50%)',
            zIndex: 1000
          }
        } else {
          const rect = injuryDropdown.element?.getBoundingClientRect?.()
          dropdownStyle = rect ? {
            position: 'fixed',
            left: `${rect.right + 30}px`,
            top: `${rect.top + rect.height / 2}px`,
            transform: 'translateY(-50%)',
            zIndex: 1000
          } : {
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 1000
          }
        }

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
                setSubstitutionDropdown(null)
                setLiberoDropdown(null)
                setLiberoInDropdown(null)
                setSanctionDropdown(null)
                setInjuryDropdown(null)
                setPlayerActionMenu(null)
              }}
            />
            {/* Dropdown */}
            <div style={dropdownStyle} className="modal-wrapper-roll-up">
              <div
                data-injury-dropdown
                style={{
                  background: 'rgba(15, 23, 42, 0.95)',
                  border: '2px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  padding: '8px',
                  minWidth: '120px',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)'
                }}
              >
              <div style={{ marginBottom: '8px', fontSize: '11px', fontWeight: 600, color: 'var(--text)', textAlign: 'center', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', paddingBottom: '6px' }}>
                Injury
              </div>
              <div style={{ marginBottom: '8px', fontSize: '11px', color: 'var(--muted)', textAlign: 'center' }}>
                # {injuryDropdown.playerNumber}
              </div>
              <button
                onClick={handleInjury}
                style={{
                  padding: '6px 12px',
                  fontSize: '11px',
                  fontWeight: 600,
                  background: 'rgba(239, 68, 68, 0.2)',
                  color: '#f87171',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  textAlign: 'center',
                  width: '100%',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(239, 68, 68, 0.3)'
                  e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.6)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'
                  e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.4)'
                }}
              >
                Substitute
              </button>
              </div>
            </div>
          </>
        )
      })()}
      
      {/* Keyboard Shortcuts Configuration Modal */}
      {keybindingsModalOpen && (
        <Modal
          title="Keyboard Shortcuts"
          open={true}
          onClose={() => {
            setKeybindingsModalOpen(false)
            setEditingKey(null)
          }}
          width={500}
        >
          <div style={{ padding: '16px', maxHeight: '70vh', overflowY: 'auto' }}>
            <p style={{ marginBottom: '16px', fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>
              Click on a key to change it. Press the new key to assign, or Escape to cancel.
            </p>
            {[
              { key: 'pointLeft', label: 'Point Left Team', description: 'Award point to left team' },
              { key: 'pointRight', label: 'Point Right Team', description: 'Award point to right team' },
              { key: 'timeoutLeft', label: 'Timeout Left Team', description: 'Call timeout for left team' },
              { key: 'timeoutRight', label: 'Timeout Right Team', description: 'Call timeout for right team' },
              { key: 'exchangeLiberoLeft', label: 'Exchange Libero Left', description: 'Exchange L1/L2 for left team' },
              { key: 'exchangeLiberoRight', label: 'Exchange Libero Right', description: 'Exchange L1/L2 for right team' },
              { key: 'undo', label: 'Undo', description: 'Undo last action' },
              { key: 'startRally', label: 'Start Rally / Confirm', description: 'Start rally or confirm modal' },
              { key: 'cancel', label: 'Cancel / Close', description: 'Cancel or close menus' }
            ].map(({ key, label, description }) => (
              <div
                key={key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  background: editingKey === key ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                  borderRadius: '6px',
                  marginBottom: '8px',
                  border: editingKey === key ? '1px solid rgba(59, 130, 246, 0.5)' : '1px solid transparent'
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '13px' }}>{label}</div>
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>{description}</div>
                </div>
                <button
                  onClick={() => {
                    if (editingKey === key) {
                      setEditingKey(null)
                    } else {
                      setEditingKey(key)
                      // Listen for next keypress
                      const handleKeyCapture = (e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        if (e.key === 'Escape') {
                          setEditingKey(null)
                        } else {
                          const newBindings = { ...keyBindings, [key]: e.key }
                          setKeyBindings(newBindings)
                          localStorage.setItem('keyBindings', JSON.stringify(newBindings))
                          setEditingKey(null)
                        }
                        window.removeEventListener('keydown', handleKeyCapture, true)
                      }
                      window.addEventListener('keydown', handleKeyCapture, true)
                    }
                  }}
                  style={{
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: 600,
                    background: editingKey === key ? '#3b82f6' : 'rgba(255, 255, 255, 0.1)',
                    color: editingKey === key ? '#fff' : 'var(--text)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    minWidth: '80px',
                    textAlign: 'center'
                  }}
                >
                  {editingKey === key ? 'Press key...' : (
                    keyBindings[key] === ' ' ? 'Space' :
                    keyBindings[key] === 'Enter' ? 'Enter' :
                    keyBindings[key] === 'Escape' ? 'Esc' :
                    keyBindings[key] === 'Backspace' ? 'Backspace' :
                    keyBindings[key] === 'ArrowUp' ? '↑' :
                    keyBindings[key] === 'ArrowDown' ? '↓' :
                    keyBindings[key] === 'ArrowLeft' ? '←' :
                    keyBindings[key] === 'ArrowRight' ? '→' :
                    keyBindings[key].toUpperCase()
                  )}
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: '12px', marginTop: '16px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setKeyBindings(defaultKeyBindings)
                  localStorage.setItem('keyBindings', JSON.stringify(defaultKeyBindings))
                }}
                style={{
                  padding: '8px 16px',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                Reset to Defaults
              </button>
              <button
                onClick={() => {
                  setKeybindingsModalOpen(false)
                  setEditingKey(null)
                }}
                style={{
                  padding: '8px 16px',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Accidental Rally Start Confirmation Modal */}
      {accidentalRallyConfirmModal && (
        <Modal
          title="Confirm Rally Start"
          open={true}
          onClose={() => setAccidentalRallyConfirmModal(null)}
          width={320}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <div style={{ marginBottom: '16px', fontSize: '48px' }}>⚠️</div>
            <p style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 600 }}>
              Rally started very quickly
            </p>
            <p style={{ marginBottom: '24px', fontSize: '12px', color: 'var(--muted)' }}>
              Are you sure the rally has actually started?
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={accidentalRallyConfirmModal.onConfirm}
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
                Yes, Start Rally
              </button>
              <button
                onClick={() => setAccidentalRallyConfirmModal(null)}
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

      {/* Accidental Point Award Confirmation Modal */}
      {accidentalPointConfirmModal && (
        <Modal
          title="Confirm Point"
          open={true}
          onClose={() => setAccidentalPointConfirmModal(null)}
          width={320}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <div style={{ marginBottom: '16px', fontSize: '48px' }}>⚠️</div>
            <p style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 600 }}>
              Point awarded very quickly
            </p>
            <p style={{ marginBottom: '24px', fontSize: '12px', color: 'var(--muted)' }}>
              Are you sure the point should be awarded to {accidentalPointConfirmModal.team === 'home' ? (data?.homeTeam?.name || 'Home') : (data?.awayTeam?.name || 'Away')}?
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={accidentalPointConfirmModal.onConfirm}
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
                Yes, Award Point
              </button>
              <button
                onClick={() => setAccidentalPointConfirmModal(null)}
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

      {sanctionConfirmModal && (() => {
        const teamData = sanctionConfirmModal.team === 'home' ? data?.homeTeam : data?.awayTeam
        const teamColor = teamData?.color || (sanctionConfirmModal.team === 'home' ? '#ef4444' : '#3b82f6')
        const teamLabel = sanctionConfirmModal.team === teamAKey ? 'A' : 'B'
        const teamName = teamData?.name || (sanctionConfirmModal.team === 'home' ? 'Home' : 'Away')
        const isBright = isBrightColor(teamColor)
        
        return (
          <Modal
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span>{teamName}</span>
                <span style={{
                  padding: '4px 12px',
                  borderRadius: '6px',
                  fontSize: '14px',
                  fontWeight: 700,
                  background: teamColor,
                  color: isBright ? '#000' : '#fff'
                }}>{teamLabel}</span>
              </div>
            }
            open={true}
            onClose={cancelSanctionConfirm}
            width={240}
            hideCloseButton={true}
          >
          <div style={{ padding: '16px', textAlign: 'center' }}>
            <p style={{ marginBottom: '12px', fontSize: '12px', color: 'var(--muted)' }}>
              {sanctionConfirmModal.type === 'player' && `#${sanctionConfirmModal.playerNumber}`}
              {sanctionConfirmModal.type === 'bench' && `Bench #${sanctionConfirmModal.playerNumber}`}
              {sanctionConfirmModal.type === 'libero' && `Libero #${sanctionConfirmModal.playerNumber}`}
              {sanctionConfirmModal.type === 'official' && `${sanctionConfirmModal.role}`}
            </p>
            <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}>
              {sanctionConfirmModal.sanctionType === 'warning' && <div className="sanction-card yellow" style={{ width: '28px', height: '38px' }}></div>}
              {sanctionConfirmModal.sanctionType === 'penalty' && <div className="sanction-card red" style={{ width: '28px', height: '38px' }}></div>}
              {sanctionConfirmModal.sanctionType === 'expulsion' && <div className="sanction-card combo" style={{ width: '32px', height: '38px' }}></div>}
              {sanctionConfirmModal.sanctionType === 'disqualification' && (
                <div className="sanction-cards-separate">
                  <div className="sanction-card yellow" style={{ width: '24px', height: '32px' }}></div>
                  <div className="sanction-card red" style={{ width: '24px', height: '32px' }}></div>
                </div>
              )}
            </div>
            <p style={{ marginBottom: '16px', fontSize: '13px', fontWeight: 600 }}>
              {sanctionConfirmModal.sanctionType === 'warning' && 'Warning'}
              {sanctionConfirmModal.sanctionType === 'penalty' && 'Penalty'}
              {sanctionConfirmModal.sanctionType === 'expulsion' && 'Expulsion'}
              {sanctionConfirmModal.sanctionType === 'disqualification' && 'Disqualification'}
            </p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
              <button
                onClick={confirmPlayerSanction}
                style={{
                  padding: '8px 16px',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                Confirm
              </button>
              <button
                onClick={cancelSanctionConfirm}
                style={{
                  padding: '8px 16px',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
        )
      })()}
      
      {substitutionConfirm && (() => {
        const teamData = substitutionConfirm.team === 'home' ? data?.homeTeam : data?.awayTeam
        const teamColor = teamData?.color || (substitutionConfirm.team === 'home' ? '#ef4444' : '#3b82f6')
        const teamLabel = substitutionConfirm.team === teamAKey ? 'A' : 'B'
        const teamName = teamData?.name || (substitutionConfirm.team === 'home' ? 'Home' : 'Away')
        const isBright = isBrightColor(teamColor)
        
        return (
          <Modal
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span>{teamName}</span>
                <span
                  style={{
                    padding: '4px 12px',
                    borderRadius: '6px',
                    fontSize: '14px',
                    fontWeight: 700,
                    background: teamColor,
                    color: isBright ? '#000' : '#fff'
                  }}
                >
                  {teamLabel}
                </span>
              </div>
            }
            open={true}
            onClose={cancelSubstitutionConfirm}
            width="auto"
            hideCloseButton={true}
          >
            <div style={{ padding: '24px', textAlign: 'center' }}>
              {substitutionConfirm.isExceptional && (
                <div style={{ marginBottom: '16px', padding: '8px', background: 'rgba(234, 179, 8, 0.2)', border: '1px solid rgba(234, 179, 8, 0.4)', borderRadius: '6px', fontSize: '12px', color: '#facc15', fontWeight: 600 }}>
                  Exceptional Substitution - Player cannot take part anymore
                </div>
              )}
            <div style={{ marginBottom: '24px', fontSize: '16px', fontWeight: 600 }}>
              <div style={{ marginBottom: '8px', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                <span>OUT: # {substitutionConfirm.playerOut}</span>
                {(substitutionConfirm.isExpelled || substitutionConfirm.isDisqualified) ? (
                  <span style={{ fontSize: '24px', fontWeight: 700, color: '#ef4444' }}>✕</span>
                ) : (
                  <span style={{ fontSize: '24px', fontWeight: 700 }}>↓</span>
                )}
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
        )
      })()}
      
      {liberoConfirm && (() => {
        const teamData = liberoConfirm.team === 'home' ? data?.homeTeam : data?.awayTeam
        const teamColor = teamData?.color || (liberoConfirm.team === 'home' ? '#ef4444' : '#3b82f6')
        const teamLabel = liberoConfirm.team === teamAKey ? 'A' : 'B'
        const teamName = teamData?.name || (liberoConfirm.team === 'home' ? 'Home' : 'Away')
        const isBright = isBrightColor(teamColor)
        
        return (
          <Modal
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span>{teamName}</span>
                <span style={{
                  padding: '4px 12px',
                  borderRadius: '6px',
                  fontSize: '14px',
                  fontWeight: 700,
                  background: teamColor,
                  color: isBright ? '#000' : '#fff'
                }}>{teamLabel}</span>
              </div>
            }
            open={true}
            onClose={cancelLiberoConfirm}
            width="auto"
            hideCloseButton={true}
          >
          <div style={{ padding: '24px', textAlign: 'center' }}>
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
        )
      })()}
      
      {liberoReentryModal && (() => {
        const teamIsLeft = (liberoReentryModal.team === 'home' && leftIsHome) || (liberoReentryModal.team === 'away' && !leftIsHome)

        let modalStyle = {}

        // Get court element
        const court = document.querySelector('.court')
        const net = document.querySelector('.court-net')

        if (teamIsLeft) {
          // For left team: align modal's top-left corner with court's top-left corner
          if (court) {
            const courtRect = court.getBoundingClientRect()
            modalStyle = {
              position: 'fixed',
              left: `${courtRect.left}px`,
              top: `${courtRect.top}px`,
              transform: 'none'
            }
          }
        } else {
          // For right team: align modal's top-left corner with net's top-right border
          if (net) {
            const netRect = net.getBoundingClientRect()
            modalStyle = {
              position: 'fixed',
              left: `${netRect.right}px`,
              top: `${netRect.top}px`,
              transform: 'none'
            }
          }
        }

        // Fallback if court/net not found
        if (!modalStyle.position) {
          const courtCenter = window.innerWidth / 2
          const courtTop = court ? court.getBoundingClientRect().top : 100

          modalStyle = {
            position: 'fixed',
            left: teamIsLeft ? '20px' : `${window.innerWidth - 420}px`,
            top: `${courtTop}px`,
            transform: 'none'
          }
        }

        // Get team info for display
        const teamData = liberoReentryModal.team === 'home' ? data?.homeTeam : data?.awayTeam
        const teamColor = teamData?.color || (liberoReentryModal.team === 'home' ? '#ef4444' : '#3b82f6')
        const teamLabel = liberoReentryModal.team === teamAKey ? 'A' : 'B'
        const teamName = teamData?.name || (liberoReentryModal.team === 'home' ? 'Home' : 'Away')
        const isBright = isBrightColor(teamColor)

        return (
            <Modal
              title={
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span>{teamName}</span>
                  <span
                    style={{
                      padding: '4px 12px',
                      borderRadius: '6px',
                      fontSize: '14px',
                      fontWeight: 700,
                      background: teamColor,
                      color: isBright ? '#000' : '#fff'
                    }}
                  >
                    {teamLabel}
                  </span>
                </div>
              }
              open={true}
              onClose={cancelLiberoReentry}
              width={400}
              hideCloseButton={true}
              position="custom"
              customStyle={modalStyle}
            >
              <div style={{ padding: '24px', textAlign: 'center' }}>
                <p style={{ marginBottom: '24px', fontSize: '16px' }}>
                  Do you want to sub a libero in position I?
                </p>
                <div style={{ marginBottom: '24px', fontSize: '16px', fontWeight: 600 }}>
                  <div style={{ marginBottom: '16px', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                    <span>OUT: # {liberoReentryModal.playerNumber}</span>
                    <span style={{ fontSize: '24px', fontWeight: 700 }}>↓</span>
                  </div>

                  {liberoReentryModal.availableLiberos && liberoReentryModal.availableLiberos.length > 0 && (
                    <div style={{ marginBottom: '16px' }}>
                      <p style={{ marginBottom: '12px', fontSize: '14px', color: 'rgba(255,255,255,0.7)' }}>
                        Select libero to substitute in:
                      </p>
                      <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                        {liberoReentryModal.availableLiberos.map((libero, index) => (
                          <div
                            key={`${libero.type}-${libero.number}`}
                            onClick={() => {
                              setLiberoReentryModal({
                                ...liberoReentryModal,
                                selectedLiberoIndex: index
                              })
                            }}
                            style={{
                              padding: '16px 24px',
                              background: index === liberoReentryModal.selectedLiberoIndex
                                ? 'var(--accent)'
                                : 'rgba(255, 255, 255, 0.1)',
                              color: index === liberoReentryModal.selectedLiberoIndex
                                ? '#000'
                                : 'var(--text)',
                              border: index === liberoReentryModal.selectedLiberoIndex
                                ? '2px solid var(--accent)'
                                : '1px solid rgba(255, 255, 255, 0.2)',
                              borderRadius: '8px',
                              cursor: 'pointer',
                              fontWeight: 600,
                              fontSize: '16px',
                              transition: 'all 0.2s ease',
                              minWidth: '100px'
                            }}
                          >
                            <div>{libero.label}</div>
                            <div style={{ fontSize: '20px', marginTop: '4px' }}>#{libero.number}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div style={{ color: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '24px', fontWeight: 700 }}>↑</span>
                    <span>IN</span>
                  </div>
                </div>
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
                    Confirm
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
                    Cancel
                  </button>
                </div>
              </div>
            </Modal>
        )
      })()}

      {liberoRedesignationModal && data && (() => {
        let availablePlayers = []
        try {
          if (getAvailablePlayersForRedesignation) {
            availablePlayers = getAvailablePlayersForRedesignation(
              liberoRedesignationModal.team,
              liberoRedesignationModal.unableLiberoNumber
            ) || []
          }
        } catch (error) {
          availablePlayers = []
        }
        return (
          <Modal
            title="Libero Re-designation"
            open={true}
            onClose={() => setLiberoRedesignationModal(null)}
            width={400}
            hideCloseButton={true}
          >
            <div style={{ padding: '24px' }}>
              <p style={{ marginBottom: '16px', fontSize: '14px', color: 'var(--text)' }}>
                Libero #{liberoRedesignationModal.unableLiberoNumber} ({liberoRedesignationModal.unableLiberoType === 'libero1' ? 'L1' : 'L2'}) is unable to play.
              </p>
              <p style={{ marginBottom: '24px', fontSize: '14px', color: 'var(--muted)' }}>
                Select a player to re-designate as Libero:
              </p>
              {availablePlayers.length === 0 ? (
                <p style={{ textAlign: 'center', color: 'var(--muted)', marginBottom: '24px' }}>
                  No available players for re-designation
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '24px', maxHeight: '300px', overflowY: 'auto' }}>
                  {availablePlayers.map(player => (
                    <button
                      key={player.id}
                      onClick={() => confirmLiberoRedesignation(player.number)}
                      style={{
                        padding: '12px',
                        fontSize: '14px',
                        fontWeight: 600,
                        background: 'rgba(255, 255, 255, 0.05)',
                        color: 'var(--text)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'all 0.2s'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                      }}
                    >
                      #{player.number} - {player.lastName || player.name} {player.firstName}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                <button
                  onClick={() => setLiberoRedesignationModal(null)}
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
      })()}
      
      {reopenSetConfirm && (
        <Modal
          title="Reopen Set"
          open={true}
          onClose={() => setReopenSetConfirm(null)}
          width={400}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px' }}>
              Reopen Set {reopenSetConfirm.setIndex}? This will delete all subsequent sets and their events.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={async () => {
                  // Mark the set as not finished
                  await db.sets.update(reopenSetConfirm.setId, { finished: false })
                  
                  // Delete all subsequent sets
                  const allSets = await db.sets.where('matchId').equals(matchId).toArray()
                  const setsToDelete = allSets.filter(s => s.index > reopenSetConfirm.setIndex)
                  for (const s of setsToDelete) {
                    // Delete events for this set
                    await db.events.where('matchId').equals(matchId).and(e => e.setIndex === s.index).delete()
                    // Delete the set
                    await db.sets.delete(s.id)
                  }
                  
                  // Update match status back to 'live' if it was 'final'
                  if (data.match?.status === 'final') {
                    await db.matches.update(matchId, { status: 'live' })
                  }
                  
                  setReopenSetConfirm(null)
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
                Yes, Reopen
              </button>
              <button
                onClick={() => setReopenSetConfirm(null)}
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

      {liberoBenchActionMenu && (() => {
        const menuStyle = {
          position: 'fixed',
          left: `${liberoBenchActionMenu.x}px`,
          top: `${liberoBenchActionMenu.y}px`,
          zIndex: 1000
        }
        
        return (
          <>
            <div 
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 999
              }}
              onClick={() => setLiberoBenchActionMenu(null)}
            />
            <div style={menuStyle}>
              <div style={{
                background: 'rgba(15, 23, 42, 0.98)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '8px',
                padding: '8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                minWidth: '180px'
              }}>
                <button
                  onClick={() => {
                    setLiberoUnableModal({
                      team: liberoBenchActionMenu.team,
                      liberoNumber: liberoBenchActionMenu.liberoNumber,
                      liberoType: liberoBenchActionMenu.liberoType
                    })
                    setLiberoBenchActionMenu(null)
                  }}
                  style={{
                    padding: '8px 12px',
                    fontSize: '13px',
                    fontWeight: 600,
                    background: 'rgba(239, 68, 68, 0.2)',
                    color: '#f87171',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(239, 68, 68, 0.3)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'
                  }}
                >
                  Declare unable to play
                </button>
                <button
                  onClick={() => {
                    setSanctionDropdown({
                      team: liberoBenchActionMenu.team,
                      type: 'libero',
                      playerNumber: liberoBenchActionMenu.liberoNumber,
                      element: liberoBenchActionMenu.element,
                      x: liberoBenchActionMenu.x,
                      y: liberoBenchActionMenu.y
                    })
                    setLiberoBenchActionMenu(null)
                  }}
                  style={{
                    padding: '8px 12px',
                    fontSize: '13px',
                    fontWeight: 600,
                    background: '#000',
                    color: '#fff',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.2s',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '6px'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#1a1a1a'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = '#000'
                  }}
                >
                  <span>Sanction</span>
                  <div style={{ display: 'flex', gap: '2px' }}>
                    <div className="sanction-card yellow" style={{ width: '12px', height: '16px' }}></div>
                    <div className="sanction-card red" style={{ width: '12px', height: '16px' }}></div>
                  </div>
                </button>
              </div>
            </div>
          </>
        )
      })()}

      {liberoUnableModal && data && (() => {
        const teamData = liberoUnableModal.team === 'home' ? data?.homeTeam : data?.awayTeam
        const teamColor = teamData?.color || (liberoUnableModal.team === 'home' ? '#ef4444' : '#3b82f6')
        const teamLabel = liberoUnableModal.team === teamAKey ? 'A' : 'B'
        const teamName = teamData?.name || (liberoUnableModal.team === 'home' ? 'Home' : 'Away')
        const isBright = isBrightColor(teamColor)
        
        return (
          <Modal
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span>{teamName}</span>
                <span
                  style={{
                    padding: '4px 12px',
                    borderRadius: '6px',
                    fontSize: '14px',
                    fontWeight: 700,
                    background: teamColor,
                    color: isBright ? '#000' : '#fff'
                  }}
                >
                  {teamLabel}
                </span>
              </div>
            }
            open={true}
            onClose={() => setLiberoUnableModal(null)}
            width={400}
            hideCloseButton={true}
          >
            <div style={{ padding: '24px' }}>
              <p style={{ marginBottom: '16px', fontSize: '14px', color: 'var(--text)' }}>
                Mark Libero #{liberoUnableModal.liberoNumber} ({liberoUnableModal.liberoType === 'libero1' ? 'L1' : 'L2'}) as unable to play?
              </p>
              <p style={{ marginBottom: '24px', fontSize: '12px', color: 'var(--muted)' }}>
                The libero can be declared unable to play if injured, ill, expelled, disqualified, or for any reason by the coach.
              </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={confirmLiberoUnable}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(239, 68, 68, 0.2)',
                  color: '#f87171',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Confirm
              </button>
              <button
                onClick={() => setLiberoUnableModal(null)}
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
      })()}
      
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
          isMatchEnd={setEndTimeModal.isMatchEnd}
          onConfirm={confirmSetEndTime}
          onCancel={() => setSetEndTimeModal(null)}
        />
      )}

      {toSubDetailsModal && (
        <ToSubDetailsModal
          type={toSubDetailsModal.type}
          side={toSubDetailsModal.side}
          timeoutDetails={toSubDetailsModal.type === 'timeout' ? getTimeoutDetails(toSubDetailsModal.side) : null}
          substitutionDetails={toSubDetailsModal.type === 'substitution' ? getSubstitutionDetails(toSubDetailsModal.side) : null}
          teamName={toSubDetailsModal.side === 'left' 
            ? (leftIsHome ? (data?.homeTeam?.name || 'Left Team') : (data?.awayTeam?.name || 'Left Team'))
            : (leftIsHome ? (data?.awayTeam?.name || 'Right Team') : (data?.homeTeam?.name || 'Right Team'))}
          onClose={() => setToSubDetailsModal(null)}
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
      
      {/* Connection Status Popover */}
      {connectionModal && connectionModal !== 'teamA' && connectionModal !== 'teamB' && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setConnectionModal(null)
            }
          }}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 10000,
            background: 'transparent'
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: `${connectionModalPosition.x}px`,
              top: `${connectionModalPosition.y}px`,
              background: 'rgba(15, 23, 42, 0.98)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '12px',
              padding: '16px',
              minWidth: '200px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              zIndex: 10001
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Thought bubble tail */}
            <div style={{
              position: 'absolute',
              top: '-7px',
              left: '20px',
              width: 0,
              height: 0,
              borderLeft: '8px solid transparent',
              borderRight: '8px solid transparent',
              borderBottom: '8px solid rgba(15, 23, 42, 0.98)'
            }} />
            <div style={{
              position: 'absolute',
              top: '-8px',
              left: '20px',
              width: 0,
              height: 0,
              borderLeft: '8px solid transparent',
              borderRight: '8px solid transparent',
              borderBottom: '8px solid rgba(255,255,255,0.2)'
            }} />
            
            <div style={{ marginBottom: '12px' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '8px'
              }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text)' }}>
                  {connectionModal === 'referee' ? 'Referee Connection' : connectionModal === 'teamA' ? `Team ${teamAShortName} Connection` : `Team ${teamBShortName} Connection`}
                </span>
                <button
                  onClick={() => setConnectionModal(null)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    fontSize: '18px',
                    lineHeight: 1,
                    padding: 0,
                    width: '20px',
                    height: '20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  ×
                </button>
              </div>
              
              <label style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                padding: '8px 0'
              }}>
                <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                  Enable Dashboard
                </span>
                <div style={{
                  position: 'relative',
                  width: '44px',
                  height: '24px',
                  background: (connectionModal === 'referee' ? refereeConnectionEnabled : connectionModal === 'teamA' ? homeTeamConnectionEnabled : awayTeamConnectionEnabled) ? '#22c55e' : '#6b7280',
                  borderRadius: '12px',
                  transition: 'background 0.2s',
                  cursor: 'pointer'
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  if (connectionModal === 'referee') {
                    handleRefereeConnectionToggle(!refereeConnectionEnabled)
                  } else if (connectionModal === 'teamA') {
                    handleHomeTeamConnectionToggle(!homeTeamConnectionEnabled)
                  } else if (connectionModal === 'teamB') {
                    handleAwayTeamConnectionToggle(!awayTeamConnectionEnabled)
                  }
                }}
                >
                  <div style={{
                    position: 'absolute',
                    top: '2px',
                    left: (connectionModal === 'referee' ? refereeConnectionEnabled : connectionModal === 'teamA' ? homeTeamConnectionEnabled : awayTeamConnectionEnabled) ? '22px' : '2px',
                    width: '20px',
                    height: '20px',
                    background: '#fff',
                    borderRadius: '50%',
                    transition: 'left 0.2s',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                  }} />
                </div>
              </label>
              
              {(connectionModal === 'referee' ? refereeConnectionEnabled : connectionModal === 'teamA' ? homeTeamConnectionEnabled : awayTeamConnectionEnabled) && (
                <div style={{
                  marginTop: '12px',
                  padding: '12px',
                  background: 'rgba(0,0,0,0.3)',
                  borderRadius: '8px'
                }}>
                  <div style={{ fontSize: '10px', color: 'var(--muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    PIN
                  </div>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px'
                  }}>
                    <span style={{
                      fontWeight: 700,
                      fontSize: '18px',
                      color: 'var(--accent)',
                      letterSpacing: '2px',
                      fontFamily: 'monospace'
                    }}>
                      {connectionModal === 'referee' 
                        ? (data?.match?.refereePin || '—') 
                        : connectionModal === 'teamA'
                        ? (data?.match?.homeTeamPin || '—')
                        : (data?.match?.awayTeamPin || '—')}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleEditPin(connectionModal === 'referee' ? 'referee' : connectionModal === 'teamA' ? 'teamA' : 'teamB')
                        setConnectionModal(null)
                      }}
                      style={{
                        padding: '4px 8px',
                        fontSize: '10px',
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
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit PIN Modal */}
      {editPinModal && (
        <Modal
          title={editPinType === 'referee' ? 'Edit Referee PIN' : editPinType === 'teamA' ? `Edit Team ${teamAShortName} PIN` : `Edit Team ${teamBShortName} PIN`}
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
      
      {/* Court Switch Modal (5th Set at 8 points) */}
      {courtSwitchModal && (
        <Modal
          title="Court Switch Required"
          open={true}
          onClose={() => {}}
          width={450}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '16px', fontSize: '18px', fontWeight: 700, color: 'var(--accent)' }}>
              Set 5 — Teams must switch courts
            </p>
            <p style={{ marginBottom: '16px', fontSize: '16px' }}>
              Score: {courtSwitchModal.homePoints} - {courtSwitchModal.awayPoints}
            </p>
            <p style={{ marginBottom: '24px', fontSize: '14px', color: 'var(--muted)' }}>
              A team has reached 8 points. Teams must change courts before continuing play.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={confirmCourtSwitch}
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
                OK - Switch Courts
              </button>
              <button
                onClick={cancelCourtSwitch}
                style={{
                  padding: '12px 32px',
                  fontSize: '16px',
                  fontWeight: 600,
                  background: '#ef4444',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Cancel - Undo Last Point
              </button>
            </div>
          </div>
        </Modal>
      )}
      
      {/* Exceptional Substitution Modal */}
      {exceptionalSubstitutionModal && (() => {
        const { team, position, playerOut, reason } = exceptionalSubstitutionModal
        const teamLabel = team === teamAKey ? 'A' : 'B'
        const reasonText = reason === 'expulsion' ? 'expelled' : reason === 'disqualification' ? 'disqualified' : 'injured'
        const exceptionalSubstitutes = getAvailableExceptionalSubstitutes(team, playerOut)
        
        return (
          <Modal
            title="No Legal Substitution Available"
            open={true}
            onClose={() => {}}
            width={500}
            hideCloseButton={true}
          >
            <div style={{ padding: '24px', textAlign: 'center' }}>
              <p style={{ marginBottom: '16px', fontSize: '18px', fontWeight: 700, color: 'var(--accent)' }}>
                Player #{playerOut} ({reasonText})
              </p>
              <p style={{ marginBottom: '16px', fontSize: '16px' }}>
                No legal substitution is possible for this player.
              </p>
              {exceptionalSubstitutes.length > 0 ? (
                <>
                  <p style={{ marginBottom: '24px', fontSize: '14px', color: 'var(--muted)' }}>
                    Choose an option:
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <button
                      onClick={() => handleExceptionalSubstitutionChoice('exceptional')}
                      style={{
                        padding: '16px 24px',
                        fontSize: '16px',
                        fontWeight: 600,
                        background: '#facc15',
                        color: '#000',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        textAlign: 'left'
                      }}
                    >
                      <div style={{ fontWeight: 700, marginBottom: '4px' }}>
                        Exceptional Substitution
                      </div>
                      <div style={{ fontSize: '13px', opacity: 0.8 }}>
                        Substitute with any eligible player on the bench (excluding liberos, expelled/disqualified players, and player #{playerOut}). Player #{playerOut} cannot take part in the game anymore.
                      </div>
                    </button>
                    <button
                      onClick={() => handleExceptionalSubstitutionChoice('forfait')}
                      style={{
                        padding: '16px 24px',
                        fontSize: '16px',
                        fontWeight: 600,
                        background: '#ef4444',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        textAlign: 'left'
                      }}
                    >
                      <div style={{ fontWeight: 700, marginBottom: '4px' }}>
                        Forfait
                      </div>
                      <div style={{ fontSize: '13px', opacity: 0.9 }}>
                        Opponent wins current set and all remaining sets (25-0 or 15-0 for set 5).
                      </div>
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ marginTop: '24px', padding: '16px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '8px' }}>
                  <p style={{ marginBottom: '16px', fontSize: '16px', fontWeight: 600, color: '#ef4444' }}>
                    No exceptional substitution possible
                  </p>
                  <p style={{ marginBottom: '16px', fontSize: '14px', color: 'var(--muted)' }}>
                    No eligible players available for exceptional substitution. Forfait will be declared automatically.
                  </p>
                  <button
                    onClick={() => handleExceptionalSubstitutionChoice('forfait')}
                    style={{
                      padding: '12px 24px',
                      fontSize: '16px',
                      fontWeight: 600,
                      background: '#ef4444',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: 'pointer'
                    }}
                  >
                    Confirm Forfait
                  </button>
                </div>
              )}
            </div>
          </Modal>
        )
      })()}
      
      {/* Set 5 Side and Service Modal */}
      {set5SideServiceModal && (() => {
        const { set4LeftTeamLabel, set4RightTeamLabel, set4ServingTeamLabel } = set5SideServiceModal
        
        // Get team data based on selected left team
        const leftTeamKey = set5SelectedLeftTeam === 'A' ? teamAKey : teamBKey
        const rightTeamKey = set5SelectedLeftTeam === 'A' ? teamBKey : teamAKey
        const leftTeamData = leftTeamKey === 'home' ? data?.homeTeam : data?.awayTeam
        const rightTeamData = rightTeamKey === 'home' ? data?.homeTeam : data?.awayTeam
        const leftTeamName = leftTeamData?.name || `Team ${set5SelectedLeftTeam}`
        const rightTeamName = rightTeamData?.name || `Team ${set5SelectedLeftTeam === 'A' ? 'B' : 'A'}`
        const leftTeamColor = leftTeamData?.color || (leftTeamKey === 'home' ? '#ef4444' : '#3b82f6')
        const rightTeamColor = rightTeamData?.color || (rightTeamKey === 'home' ? '#ef4444' : '#3b82f6')
        
        // Determine which side is serving (left or right)
        const servingTeamLabel = set5SelectedFirstServe
        const leftTeamLabel = set5SelectedLeftTeam
        const rightTeamLabel = set5SelectedLeftTeam === 'A' ? 'B' : 'A'
        const leftIsServing = servingTeamLabel === leftTeamLabel
        const rightIsServing = servingTeamLabel === rightTeamLabel
        
        return (
          <Modal
            title="Set 5 - Choose Side and Service"
            open={true}
            onClose={() => {}}
            width={500}
            hideCloseButton={true}
          >
            <div style={{ padding: '24px' }}>
              <p style={{ marginBottom: '24px', fontSize: '16px', textAlign: 'center' }}>
                Configure teams and service for Set 5.
              </p>
              
              {/* Teams on Sides */}
              <div style={{ marginBottom: '24px' }}>
                <div style={{ 
                  display: 'flex', 
                  gap: '16px', 
                  alignItems: 'center',
                  padding: '16px',
                  background: 'rgba(255, 255, 255, 0.05)',
                  borderRadius: '8px',
                  border: '1px solid rgba(255, 255, 255, 0.1)'
                }}>
                  {/* Team A Box */}
                  <div style={{ 
                    flex: 1, 
                    textAlign: 'center',
                    padding: '16px',
                    background: leftTeamColor,
                    borderRadius: '8px',
                    border: '2px solid rgba(255, 255, 255, 0.3)',
                    position: 'relative'
                  }}>
                    <div style={{ fontSize: '18px', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>
                      Team {leftTeamLabel}
                    </div>
                    <div style={{ fontSize: '14px', color: 'rgba(255, 255, 255, 0.9)', marginBottom: '8px' }}>
                      {leftTeamName}
                    </div>
                    {/* Serve ball underneath if serving */}
                    {leftIsServing && (
                      <img
                        src={mikasaVolleyball}
                        alt="Serving team"
                        style={{
                          width: '28px',
                          height: '28px',
                          filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))',
                          marginTop: '8px'
                        }}
                      />
                    )}
                  </div>
                  
                  {/* Team B Box */}
                  <div style={{ 
                    flex: 1, 
                    textAlign: 'center',
                    padding: '16px',
                    background: rightTeamColor,
                    borderRadius: '8px',
                    border: '2px solid rgba(255, 255, 255, 0.3)',
                    position: 'relative'
                  }}>
                    <div style={{ fontSize: '18px', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>
                      Team {rightTeamLabel}
                    </div>
                    <div style={{ fontSize: '14px', color: 'rgba(255, 255, 255, 0.9)', marginBottom: '8px' }}>
                      {rightTeamName}
                    </div>
                    {/* Serve ball underneath if serving */}
                    {rightIsServing && (
                      <img
                        src={mikasaVolleyball}
                        alt="Serving team"
                        style={{
                          width: '28px',
                          height: '28px',
                          filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))',
                          marginTop: '8px'
                        }}
                      />
                    )}
                  </div>
                </div>
                
                {/* Switch Teams Button */}
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: '16px' }}>
                  <button
                    onClick={() => {
                      setSet5SelectedLeftTeam(set5SelectedLeftTeam === 'A' ? 'B' : 'A')
                    }}
                    style={{
                      padding: '8px 16px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: 'rgba(255, 255, 255, 0.1)',
                      color: 'var(--text)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    Switch Teams
                  </button>
                </div>
                
                {/* Switch Serve Button */}
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: '12px' }}>
                  <button
                    onClick={() => {
                      setSet5SelectedFirstServe(set5SelectedFirstServe === 'A' ? 'B' : 'A')
                    }}
                    style={{
                      padding: '8px 16px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: 'rgba(255, 255, 255, 0.1)',
                      color: 'var(--text)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    Switch Serve
                  </button>
                </div>
              </div>
              
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                <button
                  onClick={() => confirmSet5SideService(set5SelectedLeftTeam, set5SelectedFirstServe)}
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
                  Confirm
                </button>
              </div>
            </div>
          </Modal>
        )
      })()}
      
      {liberoRotationModal && (() => {
        const teamIsLeft = (liberoRotationModal.team === 'home' && leftIsHome) || (liberoRotationModal.team === 'away' && !leftIsHome)

        let modalStyle = {}

        // Get court element
        const court = document.querySelector('.court')
        const net = document.querySelector('.court-net')

        if (teamIsLeft) {
          // For left team: align modal's top-left corner with court's top-left corner
          if (court) {
            const courtRect = court.getBoundingClientRect()
            modalStyle = {
              position: 'fixed',
              left: `${courtRect.left}px`,
              top: `${courtRect.top}px`,
              transform: 'none'
            }
          }
        } else {
          // For right team: align modal's top-left corner with net's top-right border
          if (net) {
            const netRect = net.getBoundingClientRect()
            modalStyle = {
              position: 'fixed',
              left: `${netRect.right}px`,
              top: `${netRect.top}px`,
              transform: 'none'
            }
          }
        }

        // Fallback if court/net not found
        if (!modalStyle.position) {
          const courtCenter = window.innerWidth / 2
          const courtTop = court ? court.getBoundingClientRect().top : 100

          modalStyle = {
            position: 'fixed',
            left: teamIsLeft ? '20px' : `${window.innerWidth - 420}px`,
            top: `${courtTop}px`,
            transform: 'none'
          }
        }

        // Get team info for display
        const teamData = liberoRotationModal.team === 'home' ? data?.homeTeam : data?.awayTeam
        const teamColor = teamData?.color || (liberoRotationModal.team === 'home' ? '#ef4444' : '#3b82f6')
        const teamLabel = liberoRotationModal.team === teamAKey ? 'A' : 'B'
        const teamName = teamData?.name || (liberoRotationModal.team === 'home' ? 'Home' : 'Away')
        const isBright = isBrightColor(teamColor)

        return (
            <Modal
              title={
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span>{teamName}</span>
                  <span
                    style={{
                      padding: '4px 12px',
                      borderRadius: '6px',
                      fontSize: '14px',
                      fontWeight: 700,
                      background: teamColor,
                      color: isBright ? '#000' : '#fff'
                    }}
                  >
                    {teamLabel}
                  </span>
                </div>
              }
              open={true}
              onClose={() => setLiberoRotationModal(null)}
              width={400}
              position="custom"
              hideCloseButton={true}
              customStyle={modalStyle}
            >
              <div style={{ padding: '24px', textAlign: 'center' }}>
                <p style={{ marginBottom: '24px', fontSize: '16px' }}>
                  The libero rotated to position IV and must leave the court.
                </p>
                <div style={{ marginBottom: '24px', fontSize: '16px', fontWeight: 600 }}>
                  <div style={{ marginBottom: '8px', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                    <span>OUT: {liberoRotationModal.liberoType === 'libero1' ? 'L1' : 'L2'} # {liberoRotationModal.liberoNumber}</span>
                    <span style={{ fontSize: '24px', fontWeight: 700 }}>↓</span>
                  </div>
                  <div style={{ color: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                    <span>IN: # {liberoRotationModal.playerNumber}</span>
                    <span style={{ fontSize: '24px', fontWeight: 700 }}>↑</span>
                  </div>
                </div>
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
        )
      })()}

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

      {replayRallyConfirm && (
        <Modal
          title="Replay Rally"
          open={true}
          onClose={cancelReplayRally}
          width={400}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '16px', fontSize: '16px' }}>
              Do you want to replay the rally?
            </p>
            <p style={{ marginBottom: '16px', fontSize: '14px', color: 'var(--muted)', fontStyle: 'italic' }}>
              {replayRallyConfirm.description}
            </p>
            <p style={{ marginBottom: '24px', fontSize: '13px', color: 'var(--muted)' }}>
              This will undo the last point. Click "Start rally" to replay.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={handleReplayRally}
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
                Yes, Replay
              </button>
              <button
                onClick={cancelReplayRally}
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

      {postMatchSignature && (
        <Modal
          title={`${postMatchSignature === 'home-captain' ? (data?.homeTeam?.name || 'Home') : (data?.awayTeam?.name || 'Away')} Captain Signature`}
          open={true}
          onClose={() => setPostMatchSignature(null)}
          width={500}
        >
          <div style={{ padding: '24px' }}>
            <SignaturePad
              onSave={async (signatureDataUrl) => {
                const fieldName = postMatchSignature === 'home-captain' ? 'postMatchSignatureHomeCaptain' : 'postMatchSignatureAwayCaptain'
                await db.matches.update(matchId, { [fieldName]: signatureDataUrl })
                setPostMatchSignature(null)
              }}
              onCancel={() => setPostMatchSignature(null)}
            />
          </div>
        </Modal>
      )}
    </div>
  )
}

function ScoreboardToolbar({ children }) {
  return <div className="match-toolbar">{children}</div>
}

function ScoreboardTeamColumn({ side, children }) {
  return (
    <aside className="team-controls" data-side={side}>
      {children}
    </aside>
  )
}

function ScoreboardCourtColumn({ children }) {
  return <section className="court-wrapper">{children}</section>
}

function LineupModal({ team, teamData, players, matchId, setIndex, mode = 'initial', lineup: presetLineup = null, teamAKey, teamBKey, onClose, onSave }) {
  const [lineup, setLineup] = useState(() => {
    if (presetLineup) {
      const positionMapping = ['IV', 'III', 'II', 'V', 'VI', 'I']
      return positionMapping.map(pos => (presetLineup[pos] !== undefined ? String(presetLineup[pos] ?? '') : ''))
    }
    return ['', '', '', '', '', '']
  }) // [IV, III, II, V, VI, I]
  const [errors, setErrors] = useState({}) // Use an object for specific error messages
  const [confirmMessage, setConfirmMessage] = useState(null)
  const clickTimerRef = useRef({}) // Track click times for double-click detection

  // Get all events to check for disqualifications
  const events = useLiveQuery(async () => {
    return await db.events.where('matchId').equals(matchId).toArray()
  }, [matchId])

  const handleInputChange = (index, value) => {
    const numValue = value.replace(/[^0-9]/g, '')
    const newLineup = [...lineup]
    newLineup[index] = numValue
    setLineup(newLineup)

    // Automatically validate the number as it's entered
    if (numValue && numValue.trim() !== '') {
      const num = Number(numValue)
      const player = players?.find(p => p.number === num)
      const newErrors = { ...errors }

      // Check if not on roster
      if (!player) {
        newErrors[index] = 'Not on roster'
      }
      // Check if it's a libero
      else if (player.libero && player.libero !== '') {
        newErrors[index] = 'Cannot be libero'
      }
      // Check if disqualified
      else if (events) {
        const isDisqualified = events.some(e =>
          e.type === 'sanction' &&
          e.payload?.team === team &&
          e.payload?.playerNumber === num &&
          e.payload?.type === 'disqualification'
        )
        if (isDisqualified) {
          newErrors[index] = 'Disqualified'
        }
        // Check if exceptionally substituted
        else {
          const wasExceptionallySubstituted = events.some(e =>
            e.type === 'substitution' &&
            e.payload?.team === team &&
            String(e.payload?.playerOut) === String(num) &&
            e.payload?.isExceptional === true
          )
          if (wasExceptionallySubstituted) {
            newErrors[index] = 'Exceptionally substituted'
          } else {
            // Clear error if valid
            delete newErrors[index]
          }
        }
      } else {
        // Clear error if valid
        delete newErrors[index]
      }

      setErrors(newErrors)
    } else {
      // Clear error when field is empty
      const newErrors = { ...errors }
      delete newErrors[index]
      setErrors(newErrors)
    }

    setConfirmMessage(null)
  }

  // Handle click on available player - detects double-click with custom timing
  const handlePlayerClick = (playerNumber) => {
    const now = Date.now()
    const lastClick = clickTimerRef.current[playerNumber]

    if (lastClick && now - lastClick < 400) {
      // Double-click detected (within 400ms)
      clickTimerRef.current[playerNumber] = 0 // Reset
      // Find first empty box (I to VI order: indices 5, 4, 3, 2, 1, 0 for I, VI, V, II, III, IV)
      // But we want I, II, III, IV, V, VI order, so indices: 5, 2, 1, 0, 3, 4
      const positionOrder = [5, 2, 1, 0, 3, 4] // I, II, III, IV, V, VI
      for (const idx of positionOrder) {
        if (!lineup[idx] || lineup[idx].trim() === '') {
          handleInputChange(idx, String(playerNumber))
          break
        }
      }
    } else {
      // Single click - record time
      clickTimerRef.current[playerNumber] = now
    }
  }

  const handleConfirm = () => {
    const newErrors = {}
    const lineupNumbers = lineup.map(n => (n ? Number(n) : null))

    // Check for duplicates first, as it's a cross-field validation
    const numberCounts = lineupNumbers.reduce((acc, num) => {
      if (num !== null) acc[num] = (acc[num] || 0) + 1
      return acc
    }, {})

    lineup.forEach((numStr, i) => {
      // 1. Required
      if (!numStr || numStr.trim() === '') {
        newErrors[i] = 'Required'
        return // Move to next input
      }

      const num = Number(numStr)

      // 2. Duplicate
      if (numberCounts[num] > 1) {
        newErrors[i] = 'Duplicate'
        // Don't return, so we can flag all duplicates
      }

      const player = players?.find(p => p.number === num)

      // 3. Not on roster
      if (!player) {
        newErrors[i] = 'Not on roster'
        return
      }

      // 4. Is a libero
      if (player.libero && player.libero !== '') {
        newErrors[i] = 'Cannot be libero'
        return
      }
      
      // 5. Is disqualified - cannot enter the game ever again
      if (events) {
        const isDisqualified = events.some(e => 
          e.type === 'sanction' && 
          e.payload?.team === team &&
          e.payload?.playerNumber === num &&
          e.payload?.type === 'disqualification'
        )
        if (isDisqualified) {
          newErrors[i] = 'Disqualified'
          return
        }
      }
      
      // 6. Was exceptionally substituted - cannot take part in the game anymore
      if (events) {
        const wasExceptionallySubstituted = events.some(e => 
          e.type === 'substitution' && 
          e.payload?.team === team &&
          String(e.payload?.playerOut) === String(num) &&
          e.payload?.isExceptional === true
        )
        if (wasExceptionallySubstituted) {
          newErrors[i] = 'Exceptionally substituted'
          return
        }
      }
    })
    
    // Re-check for duplicates to mark all of them
    lineupNumbers.forEach((num, i) => {
      if (num !== null && numberCounts[num] > 1) {
        newErrors[i] = 'Duplicate'
      }
    })

    setErrors(newErrors)

    if (Object.keys(newErrors).length > 0) {
      return
    }

    // Check if captain is in court
    const captain = players?.find(p => p.isCaptain)
    const captainInCourt = captain && lineupNumbers.includes(captain.number)
    
    // Save lineup: Map positions I->I, II->II, III->III, IV->IV, V->V, VI->VI
    // Lineup array indices: [0=IV, 1=III, 2=II, 3=V, 4=VI, 5=I]
    const positionMapping = ['IV', 'III', 'II', 'V', 'VI', 'I']
    const lineupData = {}
    positionMapping.forEach((pos, idx) => {
      lineupData[pos] = lineupNumbers[idx]
    })
    
    // Save lineup as an event (mark as initial lineup or manual override)
    if (matchId && setIndex) {
      // Save lineup with sequence number
      (async () => {
        // Get next sequence number
        const allEvents = await db.events.where('matchId').equals(matchId).toArray()
        const maxSeq = allEvents.reduce((max, e) => Math.max(max, e.seq || 0), 0)
        
        const manualLineupSeq = maxSeq + 1
        const manualLineupEventId = await db.events.add({
          matchId,
          setIndex,
          ts: new Date().toISOString(),
          type: 'lineup',
          payload: {
            team,
            lineup: lineupData,
            isInitial: mode === 'initial'
          },
          seq: manualLineupSeq
        })

        setConfirmMessage('Lineup saved')
        
        // Check if both lineups are now set - if so, award any pending penalty points
        // Reuse allEvents from above to avoid redeclaration
        const homeLineupSet = allEvents.some(e => 
          e.type === 'lineup' && 
          e.payload?.team === 'home' && 
          e.setIndex === setIndex &&
          e.payload?.isInitial
        )
        const awayLineupSet = allEvents.some(e => 
          e.type === 'lineup' && 
          e.payload?.team === 'away' && 
          e.setIndex === setIndex &&
          e.payload?.isInitial
        )
        
        if (homeLineupSet && awayLineupSet) {
          // Both lineups are set - check for pending penalty sanctions in this set
          const pendingPenalties = allEvents.filter(e => 
            e.type === 'sanction' && 
            e.setIndex === setIndex &&
            e.payload?.type === 'penalty'
          )
          
          // Check if points have already been awarded for these penalties
          const pointEvents = allEvents.filter(e => e.type === 'point' && e.setIndex === setIndex)
          
          if (pendingPenalties.length > 0 && pointEvents.length === 0) {
            // Award points for each pending penalty
            for (const penalty of pendingPenalties) {
              const sanctionedTeam = penalty.payload?.team
              const otherTeam = sanctionedTeam === 'home' ? 'away' : 'home'
              
              // Award point to the other team
              const currentSet = await db.sets.where('matchId').equals(matchId).and(s => s.index === setIndex).first()
              if (currentSet) {
                const field = otherTeam === 'home' ? 'homePoints' : 'awayPoints'
                const currentPoints = currentSet[field] || 0
                await db.sets.update(currentSet.id, {
                  [field]: currentPoints + 1
                })
                
                // Log point event
                const penaltyPointSeq = maxSeq + 2 + pendingPenalties.indexOf(penalty)
                await db.events.add({
                  matchId,
                  setIndex,
                  ts: new Date().toISOString(),
                  type: 'point',
                  payload: { team: otherTeam, fromPenalty: true },
                  seq: penaltyPointSeq
                })

              }
            }
          }
        }
      })().catch(err => {
        // Don't auto-close - let user close manually with close button
        setErrors({0: 'Save failed', 1: 'Save failed', 2: 'Save failed', 3: 'Save failed', 4: 'Save failed', 5: 'Save failed'})
      })
    } else {
      setConfirmMessage('Lineup saved')
      setErrors({})
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
        {/* Centered container for position inputs */}
        <div style={{ 
          display: 'flex',
          justifyContent: 'center',
          marginBottom: '24px'
        }}>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '8px',
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
              <div key={`top-${idx}`} style={{ 
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center'
              }}>
                {/* Position label rectangle */}
                <div style={{
                  width: '60px',
                  height: '24px',
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '4px 4px 0 0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: 'var(--text)'
                }}>
                  {pos}
                </div>
                {/* Input square with captain indicator (circled number) */}
                <div style={{ position: 'relative', width: '60px' }}>
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
                      padding: '0',
                      fontSize: '18px',
                      fontWeight: 700,
                      textAlign: 'center',
                      background: 'var(--bg-secondary)',
                      border: `2px solid ${errors[idx] ? '#ef4444' : 'rgba(255,255,255,0.2)'}`,
                      borderTop: 'none',
                      borderRadius: '0 0 8px 8px',
                      color: 'var(--text)'
                    }}
                  />
                  {lineup[idx] && players?.find(p => String(p.number) === String(lineup[idx]) && p.isCaptain) && (
                    <div style={{
                      position: 'absolute',
                      top: '50%',
                      left: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: '36px',
                      height: '36px',
                      borderRadius: '50%',
                      border: '2px solid var(--accent)',
                      pointerEvents: 'none',
                      zIndex: 1
                    }} />
                  )}
                </div>
                <div style={{ color: '#ef4444', fontSize: '11px', marginTop: '4px', height: '14px', textAlign: 'center' }}>
                  {errors[idx] || ''}
                </div>
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
                style={{ 
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  marginTop: '8px'
                }}
              >
                {/* Position label rectangle */}
                <div style={{
                  width: '60px',
                  height: '24px',
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '4px 4px 0 0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: 'var(--text)'
                }}>
                  {pos}
                </div>
                {/* Input square with captain indicator (circled number) */}
                <div style={{ position: 'relative', width: '60px' }}>
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
                      padding: '0',
                      fontSize: '18px',
                      fontWeight: 700,
                      textAlign: 'center',
                      background: 'var(--bg-secondary)',
                      border: `2px solid ${errors[idx] ? '#ef4444' : 'rgba(255,255,255,0.2)'}`,
                      borderTop: 'none',
                      borderRadius: '0 0 8px 8px',
                      color: 'var(--text)'
                    }}
                  />
                  {lineup[idx] && players?.find(p => String(p.number) === String(lineup[idx]) && p.isCaptain) && (
                    <div style={{
                      position: 'absolute',
                      top: '50%',
                      left: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: '36px',
                      height: '36px',
                      borderRadius: '50%',
                      border: '2px solid var(--accent)',
                      pointerEvents: 'none',
                      zIndex: 1
                    }} />
                  )}
                </div>
                <div style={{ color: '#ef4444', fontSize: '11px', marginTop: '4px', height: '14px', textAlign: 'center' }}>
                  {errors[idx] || ''}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Available players (excluding liberos and disqualified) */}
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
            {players?.filter(p => {
              // Exclude liberos
              if (p.libero && p.libero !== '') return false
              
              // Exclude players already in the lineup
              if (lineup.includes(String(p.number))) return false
              
              if (events) {
                // Exclude players substituted due to disqualification (cannot take part for rest of game)
                const wasDisqualifiedSub = events.some(e => 
                  e.type === 'substitution' && 
                  e.payload?.team === team &&
                  String(e.payload?.playerOut) === String(p.number) &&
                  e.payload?.isDisqualified === true
                )
                if (wasDisqualifiedSub) {
                  return false
                }
                
                // Exclude exceptionally substituted players (cannot take part for rest of game)
                const wasExceptionallySubstituted = events.some(e => 
                  e.type === 'substitution' && 
                  e.payload?.team === team &&
                  String(e.payload?.playerOut) === String(p.number) &&
                  e.payload?.isExceptional === true
                )
                if (wasExceptionallySubstituted) {
                  return false
                }
                
                // Exclude expelled players in the current set (cannot take part in this set)
                if (setIndex) {
                  // Check for substitution due to expulsion in current set
                  const wasExpelledSub = events.some(e => 
                    e.type === 'substitution' && 
                    e.payload?.team === team &&
                    String(e.payload?.playerOut) === String(p.number) &&
                    e.payload?.isExpelled === true &&
                    e.setIndex === setIndex
                  )
                  if (wasExpelledSub) {
                    return false
                  }
                  
                  // Also check for sanction-based expulsion in current set
                  const isExpelledInSet = events.some(e => 
                    e.type === 'sanction' && 
                    e.payload?.team === team &&
                    String(e.payload?.playerNumber) === String(p.number) &&
                    e.payload?.type === 'expulsion' &&
                    e.setIndex === setIndex
                  )
                  if (isExpelledInSet) {
                    return false
                  }
                }
                
                // Also check for sanction-based disqualification
                const isDisqualified = events.some(e => 
                  e.type === 'sanction' && 
                  e.payload?.team === team &&
                  String(e.payload?.playerNumber) === String(p.number) &&
                  e.payload?.type === 'disqualification'
                )
                if (isDisqualified) {
                  return false
                }
              }
              
              return true
            }).sort((a, b) => a.number - b.number).map(p => (
              <div
                key={p.number}
                onClick={() => handlePlayerClick(p.number)}
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
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  userSelect: 'none'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(74, 222, 128, 0.3)'
                  e.currentTarget.style.transform = 'scale(1.1)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(74, 222, 128, 0.2)'
                  e.currentTarget.style.transform = 'scale(1)'
                }}
                title="Double-click to add to first available position"
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
            background: 'rgba(74, 222, 128, 0.1)',
            border: '1px solid #4ade80',
            borderRadius: '8px',
            marginBottom: '16px',
            color: '#4ade80',
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
            onClick={() => {
              // If lineup was confirmed (confirmMessage exists), refresh state before closing
              if (confirmMessage) {
                onSave()
              } else {
                onClose()
              }
            }}
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
            border: `2px solid rgba(255,255,255,0.2)`,
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

function ToSubDetailsModal({ type, side, timeoutDetails, substitutionDetails, teamName, onClose }) {
  return (
    <Modal
      title={type === 'timeout' ? `Timeouts - ${teamName}   ` : `Substitutions - ${teamName}  ` }
      open={true}
      onClose={onClose}
      width={400}
    >
      <div style={{ padding: '20px', maxHeight: '80vh', overflowY: 'auto' }}>
        {type === 'timeout' ? (
          <div>
            {timeoutDetails && timeoutDetails.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {timeoutDetails.map((detail, index) => (
                  <div 
                    key={index}
                    style={{
                      padding: '12px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      borderRadius: '8px',
                      border: '1px solid rgba(255, 255, 255, 0.1)'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontSize: '16px', fontWeight: 600 }}>
                        Timeout {detail.index}
                      </div>
                      <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--accent)' }}>
                        {detail.score}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '20px' }}>
                No timeouts taken yet
              </div>
            )}
          </div>
        ) : (
          <div>
            {substitutionDetails && substitutionDetails.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {substitutionDetails.map((detail, index) => (
                  <div 
                    key={index}
                    style={{
                      padding: '12px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      borderRadius: '8px',
                      border: '1px solid rgba(255, 255, 255, 0.1)'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <div style={{ fontSize: '16px', fontWeight: 600 }}>
                        Substitution {detail.index}
                      </div>
                      <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--accent)' }}>
                        {detail.score}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '16px', fontSize: '14px', color: 'var(--muted)' }}>
                      <div>
                        <span style={{ fontWeight: 600 }}>Position:</span> {detail.position}
                      </div>
                      <div>
                        <span style={{ fontWeight: 600 }}>Out:</span> {detail.playerOut}
                      </div>
                      <div>
                        <span style={{ fontWeight: 600 }}>In:</span> {detail.playerIn}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '20px' }}>
                No substitutions taken yet
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

function SetEndTimeModal({ setIndex, winner, homePoints, awayPoints, defaultTime, teamAKey, isMatchEnd, onConfirm, onCancel }) {
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
      title={isMatchEnd ? 'Match End' : `Set ${setIndex} End`}
      open={true}
      onClose={onCancel}
      width={400}
      hideCloseButton={true}
    >
      <div style={{ padding: '24px', textAlign: 'center' }}>
        <p style={{ marginBottom: '16px', fontSize: '18px', fontWeight: 700 }}>
          {isMatchEnd ? `Team ${winnerLabel} won the Match!` : `Team ${winnerLabel} won Set ${setIndex}!`}
        </p>
        <p style={{ marginBottom: '24px', fontSize: '16px', color: 'var(--muted)' }}>
          Set {setIndex}: {homePoints} - {awayPoints}
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
            border: `2px solid rgba(255,255,255,0.2)`,
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
