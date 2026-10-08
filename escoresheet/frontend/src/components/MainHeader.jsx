import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
import ConnectionStatus from './ConnectionStatus'
import UserButton from './auth/UserButton'
import TabletStatusIndicator from './TabletStatusIndicator'
import ConnectTabletsModal from './connect/ConnectTabletsModal'
import { useScaledLayout } from '../hooks/useScaledLayout'
import { BellIcon, SatelliteDishIcon, ClipboardIcon, ZoomInIcon, HomeIcon } from './icons'
import { ChevronDown, ChevronUp, Maximize, Menu, Minimize, Power, Tablet, X } from 'lucide-react'
import { isDesktopScoretable, requestDesktopQuit } from '../utils/appLifecycle'
import { cn } from '../ui/cn.js'
import { SwitchTrack } from '../ui/Switch.jsx'
import {
  FOCUS_RING, KIT_SCOPE, HEADER_BAR, HEADER_BTN, HEADER_BTN_ON, POPOVER_PANEL, MENU_PANEL, MENU_ROW, MENU_SUBROW, MENU_ROW_ON,
  MENU_NEST, MENU_SEP, MENU_ICON, MENU_COUNT, STATUS_PILL, STATUS_TONES, HEADER_SWITCH
} from './chromeClasses'


const FlagBox = ({ children }) => (
  <span
    style={{
      width: '20px',
      height: '14px',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 20px',
    }}
  >
    {children}
  </span>
)

// Small flag SVG components
const FlagGB = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="60" height="42" fill="#012169" />
    <path d="M0,0 L60,42 M60,0 L0,42" stroke="#fff" strokeWidth="7" />
    <path d="M0,0 L60,42 M60,0 L0,42" stroke="#C8102E" strokeWidth="4" clipPath="url(#gbClip)" />
    <path d="M30,0 V42 M0,21 H60" stroke="#fff" strokeWidth="12" />
    <path d="M30,0 V42 M0,21 H60" stroke="#C8102E" strokeWidth="7" />
  </svg>
)

const FlagIT = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="20" height="42" fill="#009246" />
    <rect x="20" width="20" height="42" fill="#fff" />
    <rect x="40" width="20" height="42" fill="#CE2B37" />
  </svg>
)

const FlagDE = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="60" height="14" fill="#000" />
    <rect y="14" width="60" height="14" fill="#DD0000" />
    <rect y="28" width="60" height="14" fill="#FFCE00" />
  </svg>
)

const FlagFR = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="20" height="42" fill="#002395" />
    <rect x="20" width="20" height="42" fill="#fff" />
    <rect x="40" width="20" height="42" fill="#ED2939" />
  </svg>
)

const FlagCH = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 32 32"
    style={{
      borderRadius: '2px',
      boxShadow: '0 0 1px rgba(0,0,0,0.3)',
    }}
  >
    {/* Red background */}
    <rect width="32" height="32" fill="#ff0000" />

    {/* Vertical arm */}
    <rect x="14" y="6" width="4" height="20" fill="#fff" />

    {/* Horizontal arm */}
    <rect x="6" y="14" width="20" height="4" fill="#fff" />
  </svg>
)


// Language options with flag components
const languages = [
  { code: 'en', Flag: FlagGB, label: 'EN' },
  { code: 'it', Flag: FlagIT, label: 'IT' },
  { code: 'de', Flag: FlagDE, label: 'DE' },
  { code: 'de-CH', Flag: FlagCH, label: 'DE' },
  { code: 'fr', Flag: FlagFR, label: 'FR' }
]

export default function MainHeader({
  connectionStatuses,
  connectionDebugInfo,
  showMatchSetup,
  matchId,
  currentMatch,
  matchInfoMenuOpen,
  setMatchInfoMenuOpen,
  matchInfoData,
  matchStatus,
  currentOfficialMatch,
  currentTestMatch,
  isFullscreen,
  toggleFullscreen,
  offlineMode,
  setOfflineMode,
  onOpenSetup,
  onRetryErrors,
  queueStats = { pending: 0, error: 0 },
  dashboardServer = null, // { enabled, dashboardCount, refereePin, onOpenOptions }
  collapsible = false, // Only allow collapsing on Scoreboard page
  startCollapsed = false, // Collapse when this turns true (the scoring screen's phone layout)
  onTriggerAlarm = null, // Trigger scorer attention alarm
  alarmEnabled = false, // Only show alarm when sync/dashboard is active
  currentPage = 'home',
  onToggleHelp = null,
  helpPanelOpen = false,
}) {
  const { t } = useTranslation()
  const { scaleFactor, userScaleOverride, setUserScaleOverride } = useScaledLayout()
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false)
  const [scaleMenuOpen, setScaleMenuOpen] = useState(false)

  // Scale options: 50%, 75%, 100%, 125%, 150% (25% steps, max 150%)
  const scaleOptions = [0.5, 0.75, 1.0, 1.25, 1.5]
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const [editingSize, setEditingSize] = useState({ width: '', height: '' })
  const [isEditing, setIsEditing] = useState(false)
  const [dashboardMenuOpen, setDashboardMenuOpen] = useState(false)
  const [dashboardMenuPos, setDashboardMenuPos] = useState({ top: 0, right: 12 })
  const dashboardButtonRef = useRef(null)
  // WxH indicator hidden by default - can be toggled via settings if needed
  const [showViewportSize] = useState(() => {
    const saved = localStorage.getItem('showViewportSize')
    return saved === 'true' // Default to hidden
  })
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
  // Connect tablets: every role's link, QR code and PIN over the hall Wi-Fi,
  // the laptop's own Wi-Fi, the cloud or Bluetooth (the desktop app replaces
  // its native Help menu with this row)
  const [lanTabletsOpen, setLanTabletsOpen] = useState(false)
  const actionsMenuRef = useRef(null)
  const touchStartY = useRef(0)
  const headerRef = useRef(null)
  // Use version from package.json (injected by Vite at build time)
  const currentVersion = __APP_VERSION__

  // Check if compact mode (viewport width <= 960px)
  const isCompactMode = viewportSize.width > 0 && viewportSize.width <= 960

  // Effective collapsed state - only collapse when collapsible is true
  const effectivelyCollapsed = collapsible && isCollapsed

  // The phone scoring layout fills the screen: the header starts folded
  // away (its thin bar opens it again)
  useEffect(() => {
    if (startCollapsed) setIsCollapsed(true)
  }, [startCollapsed])

  // Handle touch events for swipe to show/hide header (compact mode only for touch)
  useEffect(() => {
    // Touch swipe only works in compact mode when collapsible
    if (!isCompactMode || !collapsible) {
      return
    }

    const handleTouchStart = (e) => {
      touchStartY.current = e.touches[0].clientY
    }

    const handleTouchEnd = (e) => {
      const touchEndY = e.changedTouches[0].clientY
      const deltaY = touchEndY - touchStartY.current

      // If touch started near top of screen (within 60px) and swiped down
      if (touchStartY.current < 60 && deltaY > 30) {
        setIsCollapsed(false)
      }
      // If touch started anywhere and swiped up significantly
      else if (deltaY < -50 && !isCollapsed) {
        setIsCollapsed(true)
      }
    }

    document.addEventListener('touchstart', handleTouchStart)
    document.addEventListener('touchend', handleTouchEnd)

    return () => {
      document.removeEventListener('touchstart', handleTouchStart)
      document.removeEventListener('touchend', handleTouchEnd)
    }
  }, [isCompactMode, isCollapsed, collapsible])

  // Track viewport dimensions
  useEffect(() => {
    const updateViewportSize = () => {
      const newSize = {
        width: window.innerWidth,
        height: window.innerHeight
      }
      setViewportSize(newSize)
      // Update editing values if not currently editing
      if (!isEditing) {
        setEditingSize({
          width: newSize.width.toString(),
          height: newSize.height.toString()
        })
      }
    }

    // Set initial size
    const initialSize = {
      width: window.innerWidth,
      height: window.innerHeight
    }
    setViewportSize(initialSize)
    setEditingSize({
      width: initialSize.width.toString(),
      height: initialSize.height.toString()
    })

    // Update on resize
    window.addEventListener('resize', updateViewportSize)
    return () => window.removeEventListener('resize', updateViewportSize)
  }, [isEditing])

  // The header menu closes on Escape, on a press outside it (a dialog opened
  // from it counts as outside) and when the screen changes (new match, setup,
  // home): it stayed open over Match setup and covered 'Create match'.
  useEffect(() => {
    if (!actionsMenuOpen) return
    const handlePointerDown = (e) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target)) {
        setActionsMenuOpen(false)
      }
    }
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setActionsMenuOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [actionsMenuOpen])

  useEffect(() => {
    setActionsMenuOpen(false)
  }, [matchId, showMatchSetup, currentPage])

  // Close dashboard menu when clicking outside
  useEffect(() => {
    if (!dashboardMenuOpen) return
    const handleClickOutside = (e) => {
      if (dashboardButtonRef.current && !dashboardButtonRef.current.contains(e.target)) {
        setDashboardMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [dashboardMenuOpen])

  // Calculate dashboard menu position
  const openDashboardMenu = () => {
    if (dashboardButtonRef.current) {
      const rect = dashboardButtonRef.current.getBoundingClientRect()
      const menuWidth = 280
      // Calculate right position, ensuring menu stays within viewport
      let rightPos = window.innerWidth - rect.right
      // If menu would overflow left side, align to left edge with padding
      if (rect.right - menuWidth < 12) {
        rightPos = window.innerWidth - menuWidth - 12
      }
      setDashboardMenuPos({
        top: rect.bottom + 8,
        right: Math.max(12, rightPos)
      })
    }
    setDashboardMenuOpen(!dashboardMenuOpen)
  }

  // Handle viewport resize
  const handleResizeViewport = () => {
    const width = parseInt(editingSize.width)
    const height = parseInt(editingSize.height)

    if (!isNaN(width) && !isNaN(height) && width > 0 && height > 0) {
      try {
        // Try to resize the window
        // Note: window.resizeTo() only works if:
        // 1. The window was opened by window.open() (popup)
        // 2. In Electron apps (which this appears to be)
        // 3. In some browser extensions

        // Set minimum sizes for safety
        const minWidth = 300
        const minHeight = 200
        const safeWidth = Math.max(width, minWidth)
        const safeHeight = Math.max(height, minHeight)

        if (typeof window.resizeTo === 'function') {
          window.resizeTo(safeWidth, safeHeight)
          // Update state after a brief delay to allow resize to complete
          setTimeout(() => {
            setViewportSize({
              width: window.innerWidth,
              height: window.innerHeight
            })
          }, 100)
        } else {
          // If resizeTo is not available, just update the display
          setViewportSize({ width: safeWidth, height: safeHeight })
        }
      } catch (e) {
        console.warn('Could not resize window:', e)
        // Still update the display even if resize fails
        setViewportSize({ width, height })
      }
    } else {
      // Invalid input, revert to current size
      setEditingSize({
        width: viewportSize.width.toString(),
        height: viewportSize.height.toString()
      })
    }
    setIsEditing(false)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleResizeViewport()
    } else if (e.key === 'Escape') {
      setEditingSize({
        width: viewportSize.width.toString(),
        height: viewportSize.height.toString()
      })
      setIsEditing(false)
    }
  }

  const renderMatchInfoMenu = (match, matchData) => {
    if (!matchData) return null

    return (
      <div
        data-match-info-menu
        onClick={(e) => e.stopPropagation()}
        className={cn('absolute left-1/2 top-full mt-1.5 flex min-w-[280px] -translate-x-1/2 flex-col gap-2 text-center', POPOVER_PANEL)}
        style={{ zIndex: 1000 }}
      >
        {/* Match Number */}
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">{t('header.notSynced')}</div>
        <div className="text-sm font-bold text-stone-900 tabular-nums">
          {t('header.match')} {(matchData.match.gameNumber || matchData.match.game_n) ? (matchData.match.gameNumber || matchData.match.game_n) : t('header.notSet')}
        </div>

        {/* Match ID - for debugging/support */}
        {matchId && (
          <div className="font-mono text-[10px] text-stone-500">
            ID: {matchId}
          </div>
        )}

        {/* Teams */}
        <div className="text-sm font-medium text-stone-700">
          {(matchData.homeTeam?.name && matchData.awayTeam?.name)
            ? `${matchData.homeTeam.name} - ${matchData.awayTeam.name}`
            : t('header.notSet')}
        </div>

        {/* Date and Time */}
        <div className="text-xs tabular-nums text-stone-500">
          {matchData.match.scheduledAt ? (
            (() => {
              try {
                const date = new Date(matchData.match.scheduledAt)
                // Display as UTC (no timezone conversion) since we store time as-entered
                // Explicitly format as dd/mm/yyyy HH:mm
                const day = String(date.getUTCDate()).padStart(2, '0')
                const month = String(date.getUTCMonth() + 1).padStart(2, '0')
                const year = date.getUTCFullYear()
                const hours = String(date.getUTCHours()).padStart(2, '0')
                const minutes = String(date.getUTCMinutes()).padStart(2, '0')
                return `${day}/${month}/${year}, ${hours}:${minutes}`
              } catch {
                return matchData.match.scheduledAt
              }
            })()
          ) : t('header.notSet')}
        </div>

        {/* PIN or TEST */}
        <div className={cn(
          'rounded-lg border px-3 py-1.5 text-sm font-semibold',
          matchData.match.test
            ? 'border-amber-200 bg-amber-50 text-[11px] uppercase tracking-[0.08em] text-amber-800'
            : 'border-stone-200 bg-stone-50 font-mono tracking-[0.3em] text-stone-900'
        )}>
          {matchData.match.test ? t('header.test') : (matchData.match.gamePin || 'N/A')}
        </div>
      </div>
    )
  }

  const renderMatchInfoButton = (match) => {
    // Hide button if no match exists or no valid match number (unless it's a test match)
    if (!match || (!match.test && !match.gameNumber && !match.game_n)) return null

    const isTest = match?.test
    const matchNumber = match?.gameNumber || match?.game_n || 'N/A'
    const buttonText = isTest ? t('header.testMatch') : t('header.matchNumber', { number: matchNumber })

    return (
      <div className="relative flex h-8 w-auto items-center justify-center gap-1.5">
        <span className={KIT_SCOPE}>
          <button
            type="button"
            data-match-info-menu
            aria-expanded={matchInfoMenuOpen}
            onClick={(e) => {
              e.stopPropagation()
              setMatchInfoMenuOpen(!matchInfoMenuOpen)
            }}
            className={cn(
              'inline-flex h-7 min-w-[100px] items-center justify-center gap-1 rounded-full border px-3 text-xs font-semibold tabular-nums transition-colors cursor-pointer',
              FOCUS_RING,
              isTest
                ? 'border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-200/70'
                : 'border-stone-200 bg-white text-stone-700 hover:bg-stone-100'
            )}
          >
            <span>{buttonText}</span>
            <ChevronDown size={13} aria-hidden="true" className={cn('transition-transform', matchInfoMenuOpen && 'rotate-180')} />
          </button>
        </span>

        {/* Header collapse toggle button */}
        {collapsible && (
          <span className={KIT_SCOPE}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setIsCollapsed(!isCollapsed)
              }}
              className={cn(HEADER_BTN, 'h-7 w-7 px-0')}
              aria-label={isCollapsed ? t('header.showHeader') : t('header.hideHeader')}
              title={isCollapsed ? t('header.showHeader') : t('header.hideHeader')}
            >
              <ChevronUp size={15} aria-hidden="true" className={cn('transition-transform', isCollapsed && 'rotate-180')} />
            </button>
          </span>
        )}

        {/* Collapsible Match Info Menu - hide when header is collapsed */}
        {matchInfoMenuOpen && matchInfoData && !effectivelyCollapsed && renderMatchInfoMenu(match, matchInfoData)}
      </div>
    )
  }

  // One look for every row of the header menus (desktop and compact).
  const currentLanguage = languages.find(l => l.code === i18n.language)
  const CurrentFlag = currentLanguage ? currentLanguage.Flag : FlagGB
  const isCurrentScale = (scale) => userScaleOverride === scale || (userScaleOverride === null && scale === 1.0)

  const languageOptions = (
    <div className={MENU_NEST}>
      {languages.map((lang) => (
        <button
          type="button"
          key={lang.code}
          aria-pressed={i18n.language === lang.code}
          onClick={(e) => {
            e.stopPropagation()
            i18n.changeLanguage(lang.code)
            setLanguageMenuOpen(false)
          }}
          className={cn(MENU_SUBROW, i18n.language === lang.code && MENU_ROW_ON)}
        >
          <FlagBox><lang.Flag /></FlagBox>
          <span>{lang.label}</span>
        </button>
      ))}
    </div>
  )

  const scaleOptionsList = (
    <div className={MENU_NEST}>
      {scaleOptions.map((scale) => (
        <button
          type="button"
          key={scale}
          aria-pressed={isCurrentScale(scale)}
          onClick={(e) => {
            e.stopPropagation()
            setUserScaleOverride(scale === 1.0 ? null : scale)
            setScaleMenuOpen(false)
          }}
          className={cn(MENU_SUBROW, 'justify-center tabular-nums', isCurrentScale(scale) && MENU_ROW_ON)}
        >
          <span>{Math.round(scale * 100)}%{scale === 1.0 ? ` (${t('header.default', 'Default')})` : ''}</span>
        </button>
      ))}
    </div>
  )

  // Desktop app: closing the window only hides it to the tray (the tablets
  // stay connected), so quitting is a menu row that asks first
  // (utils/appLifecycle.js, src-tauri/src/lifecycle.rs).
  const quitRow = isDesktopScoretable() && (
    <>
      <div className={MENU_SEP} />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setActionsMenuOpen(false)
          requestDesktopQuit()
        }}
        className={MENU_ROW}
        data-testid="header-quit-app"
      >
        <span className={MENU_ICON}><Power size={15} /></span>
        <span>{t('appLifecycle.trayQuit', 'Quit OpenVolley…')}</span>
      </button>
    </>
  )

  const helpButton = onToggleHelp && (
    <span className={KIT_SCOPE}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggleHelp()
        }}
        aria-pressed={helpPanelOpen}
        className={cn(HEADER_BTN, 'w-9 px-0 text-sm font-bold', helpPanelOpen && HEADER_BTN_ON)}
        title={t('contextHelp.helpButton', 'Help')}
      >
        ?
      </button>
    </span>
  )

  // Fullscreen sits in the bar next to ? and the menu (one click, not a menu row)
  const fullscreenButton = (
    <span className={KIT_SCOPE}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          toggleFullscreen()
        }}
        aria-pressed={!!isFullscreen}
        className={cn(HEADER_BTN, 'w-9 px-0', isFullscreen && HEADER_BTN_ON)}
        aria-label={isFullscreen ? t('header.exitFullscreen') : t('header.fullscreen')}
        title={isFullscreen ? t('header.exitFullscreen') : t('header.fullscreen')}
      >
        {isFullscreen ? <Minimize size={16} aria-hidden="true" /> : <Maximize size={16} aria-hidden="true" />}
      </button>
    </span>
  )

  return (
    <div style={{ position: 'relative', zIndex: 1000 }}>
      <div
        ref={headerRef}
        data-diag="header"
        className={effectivelyCollapsed ? 'bg-white' : HEADER_BAR}
        style={{
          display: 'flex',
          height: effectivelyCollapsed ? '0px' : `${40 * scaleFactor}px`,
          minHeight: effectivelyCollapsed ? '0px' : `${40 * scaleFactor}px`,
          maxHeight: effectivelyCollapsed ? '0px' : `${40 * scaleFactor}px`,
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: effectivelyCollapsed ? '0' : `0 ${Math.round(12 * scaleFactor)}px`,
          flexShrink: 0,
          gap: `${Math.round(10 * scaleFactor)}px`,
          overflow: effectivelyCollapsed ? 'hidden' : 'visible',
          transition: 'all 0.3s ease-in-out',
          fontSize: `${Math.round(14 * scaleFactor)}px`
        }}>
        {/* Left: Online/Offline Toggle + Connection Status */}
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Online/Offline Toggle */}
          <span className={KIT_SCOPE}>
            <button
              type="button"
              role="switch"
              aria-checked={!offlineMode}
              onClick={() => setOfflineMode(!offlineMode)}
              title={offlineMode ? t('header.switchToOnline') : t('header.switchToOffline')}
              className={HEADER_SWITCH}
            >
              <span>{offlineMode ? t('header.offline') : t('header.online')}</span>
              {/* Toggle Switch: emerald when online (no brand red on the scoreboard, R4) */}
              <SwitchTrack checked={!offlineMode} className={!offlineMode ? 'bg-emerald-500' : undefined} />
            </button>
          </span>

          {/* Connection Status - only show in online mode */}
          {!offlineMode && (
            <ConnectionStatus
              connectionStatuses={connectionStatuses}
              connectionDebugInfo={connectionDebugInfo}
              queueStats={queueStats}
              onRetryErrors={onRetryErrors}
              position="left"
              size="normal"
            />
          )}

          {/* Alarm Bell Button - visible if alarm is enabled and match is active */}
          {alarmEnabled && onTriggerAlarm && matchId && (
            <span className={KIT_SCOPE}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onTriggerAlarm()
                }}
                aria-label={t('header.alarmBellNotify')}
                title={t('header.alarmBellNotify')}
                className={cn(HEADER_BTN, HEADER_BTN_ON, 'w-9 px-0')}
              >
                <BellIcon size={14} />
              </button>
            </span>
          )}

          {/* Dashboard Server Indicator */}
          {dashboardServer?.enabled && (
            <div ref={dashboardButtonRef} style={{ position: 'relative' }}>
              <span className={KIT_SCOPE}>
                <button
                  type="button"
                  onClick={openDashboardMenu}
                  aria-expanded={dashboardMenuOpen}
                  title={`${dashboardServer.dashboardCount || 0} dashboard(s) connected${dashboardServer.refereePin ? ` | PIN: ${dashboardServer.refereePin}` : ''}`}
                  className={cn(STATUS_PILL, FOCUS_RING, dashboardServer.dashboardCount > 0 ? STATUS_TONES.ok.pill : STATUS_TONES.info.pill)}
                >
                  <SatelliteDishIcon size={12} />
                  {dashboardServer.dashboardCount > 0 ? (
                    <span className="tabular-nums">{dashboardServer.dashboardCount}</span>
                  ) : (
                    <span>{t('header.connectDevices')}</span>
                  )}
                  {dashboardServer.refereePin && dashboardServer.dashboardCount > 0 && (
                    <span className="rounded bg-stone-100 px-1.5 py-px font-mono text-[10px] tracking-[0.15em] text-stone-700">
                      {dashboardServer.refereePin}
                    </span>
                  )}
                  <ChevronDown size={12} aria-hidden="true" className={cn('transition-transform', dashboardMenuOpen && 'rotate-180')} />
                </button>
              </span>

              {/* Dashboard Connection Info Dropdown */}
              {dashboardMenuOpen && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className={cn('fixed w-[280px] max-w-[calc(100vw-24px)] space-y-3 text-sm', POPOVER_PANEL)}
                  style={{
                    top: `${dashboardMenuPos.top}px`,
                    right: `${dashboardMenuPos.right}px`,
                    zIndex: 1000
                  }}
                >
                  <div className="border-b border-stone-100 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {t('header.dashboardConnectionInfo')}
                  </div>

                  {/* Server Status */}
                  <div className="flex items-center gap-2">
                    <span className={cn('inline-block h-2 w-2 rounded-full', dashboardServer.serverRunning ? 'bg-emerald-500' : 'bg-red-500')}></span>
                    <span className="text-xs font-semibold text-stone-800">
                      {dashboardServer.serverRunning ? t('header.serverRunning') : t('header.serverNotRunning')}
                    </span>
                  </div>

                  {/* IP Address - Prominent Display */}
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 text-center">
                    <div className="mb-1 text-[11px] text-stone-500">
                      {t('header.connectDevicesToIp')}
                    </div>
                    <div className="font-mono text-base font-semibold text-emerald-800">
                      {dashboardServer.serverIP || t('header.notAvailable')}
                      {dashboardServer.serverPort && dashboardServer.serverPort !== 80 && dashboardServer.serverPort !== 443 && (
                        <span className="text-stone-500">:{dashboardServer.serverPort}</span>
                      )}
                    </div>
                  </div>

                  {/* Connection URLs */}
                  {dashboardServer.serverIP && (
                    <div className="rounded-lg border border-stone-200 bg-stone-50 p-2.5">
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                        {t('header.dashboardUrls')}
                      </div>
                      <div className="flex flex-col gap-1.5 font-mono text-[11px] text-stone-700">
                        {dashboardServer.connectionUrl && (
                          <div className="break-all">
                            <span className="mr-1 text-stone-500">{t('header.referee')}:</span>
                            <span>{dashboardServer.connectionUrl}/referee</span>
                          </div>
                        )}
                        {dashboardServer.connectionUrl && (
                          <div className="break-all">
                            <span className="mr-1 text-stone-500">{t('header.bench')}:</span>
                            <span>{dashboardServer.connectionUrl}/bench</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Connected Dashboards Count */}
                  <div className="rounded-lg border border-stone-200 bg-stone-50 p-2.5">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                      {t('header.connectedDevices')}
                    </div>
                    <div className="flex gap-4 text-xs text-stone-700">
                      <div>
                        <span className="text-stone-500">{t('header.total')}: </span>
                        <span className="font-semibold tabular-nums">{dashboardServer.dashboardCount || 0}</span>
                      </div>
                      <div>
                        <span className="text-stone-500">{t('header.referees')}: </span>
                        <span className="font-semibold tabular-nums">{dashboardServer.refereeCount || 0}</span>
                      </div>
                      <div>
                        <span className="text-stone-500">{t('header.bench')}: </span>
                        <span className="font-semibold tabular-nums">{dashboardServer.benchCount || 0}</span>
                      </div>
                    </div>
                  </div>

                  {/* PIN */}
                  {dashboardServer.refereePin && (
                    <div className="rounded-lg border border-stone-200 bg-stone-50 p-2.5">
                      <div className="mb-1 text-[11px] text-stone-500">{t('header.matchPin')}</div>
                      <div className="font-mono text-lg font-semibold tracking-[0.3em] text-stone-900">
                        {dashboardServer.refereePin}
                      </div>
                    </div>
                  )}

                  {/* More Options Button */}
                  <button
                    type="button"
                    onClick={() => {
                      setDashboardMenuOpen(false)
                      dashboardServer.onOpenOptions?.()
                    }}
                    className={cn('inline-flex h-10 w-full items-center justify-center rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium tracking-normal text-stone-700 hover:bg-stone-50 transition-colors cursor-pointer', FOCUS_RING)}
                  >
                    {t('header.moreOptions')}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Tablet Status Indicator */}
          {currentMatch && <TabletStatusIndicator match={currentMatch} />}
        </div>

        {/* Center: Collapsible Match Info Menu - Absolutely positioned for true centering */}
        {/* Only show when match has a gamePin set OR is a test match */}
        {!effectivelyCollapsed && (((showMatchSetup || matchId) && currentMatch && (currentMatch.gamePin || currentMatch.test)) || (!matchId && matchStatus && (currentOfficialMatch || currentTestMatch) && ((currentOfficialMatch || currentTestMatch)?.gamePin || (currentOfficialMatch || currentTestMatch)?.test))) ? (
          <div style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 101
          }}>
            {(showMatchSetup || matchId) && currentMatch ? (
              renderMatchInfoButton(currentMatch)
            ) : (
              renderMatchInfoButton(currentOfficialMatch || currentTestMatch)
            )}
          </div>
        ) : null}

        {/* Right: Home Button, Version and Fullscreen */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'clamp(8px, 1.5vw, 12px)',
          flex: '0 0 auto',
          alignSelf: 'stretch',
          position: 'relative'
        }}>
          {/* Compact Mode: Collapsible Actions Menu */}
          {isCompactMode ? (
            <>
              {/* Help Button */}
              {helpButton}

              {/* User Button - hidden in offline mode */}
              {!offlineMode && <UserButton inMatch={!!matchId} />}

              <div ref={actionsMenuRef} style={{ position: 'relative' }}>
                <span className={KIT_SCOPE}>
                  <button
                    type="button"
                    aria-expanded={actionsMenuOpen}
                    onClick={(e) => {
                      e.stopPropagation()
                      setActionsMenuOpen(!actionsMenuOpen)
                    }}
                    className={cn(HEADER_BTN, actionsMenuOpen && HEADER_BTN_ON)}
                  >
                    <span>{isFullscreen ? t('header.exit') : t('header.fullscreen')}</span>
                    <ChevronDown size={12} aria-hidden="true" className={cn('transition-transform', actionsMenuOpen && 'rotate-180')} />
                  </button>
                </span>

                {/* Expanded Actions Menu */}
                {actionsMenuOpen && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className={cn('absolute right-0 top-full mt-1.5 flex min-w-[220px] max-h-[calc(100vh-56px)] flex-col overflow-y-auto', MENU_PANEL)}
                    style={{ zIndex: 1000 }}
                  >
                    {/* Fullscreen Action */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleFullscreen()
                        setActionsMenuOpen(false)
                      }}
                      className={MENU_ROW}
                    >
                      <span className={MENU_ICON}>{isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}</span>
                      <span>{isFullscreen ? t('header.exitFullscreen') : t('header.fullscreen')}</span>
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setLanTabletsOpen(true)
                        setActionsMenuOpen(false)
                      }}
                      className={MENU_ROW}
                      data-testid="header-connect-tablets"
                    >
                      <span className={MENU_ICON}><Tablet size={15} /></span>
                      <span>{t('connectTablets.title', 'Connect tablets')}</span>
                    </button>

                    {/* Version (about) */}
                    <div className={cn(MENU_ROW, 'cursor-default text-stone-500 hover:bg-transparent')} data-testid="header-version">
                      <span className={MENU_ICON}><ClipboardIcon size={14} /></span>
                      <span className="flex-1 tabular-nums">{t('header.versionLabel', 'Version {{version}}', { version: currentVersion })}</span>
                    </div>

                    {/* Language Selector Action */}
                    <button
                      type="button"
                      aria-expanded={languageMenuOpen}
                      onClick={(e) => {
                        e.stopPropagation()
                        setLanguageMenuOpen(!languageMenuOpen)
                      }}
                      className={cn(MENU_ROW, languageMenuOpen && 'bg-stone-100')}
                    >
                      <span className={MENU_ICON}><CurrentFlag /></span>
                      <span>{currentLanguage?.label || 'EN'}</span>
                    </button>

                    {/* Language Options - nested dropdown */}
                    {languageMenuOpen && languageOptions}

                    {/* Display Scale Selector - Compact Mode */}
                    <button
                      type="button"
                      aria-expanded={scaleMenuOpen}
                      onClick={(e) => {
                        e.stopPropagation()
                        setScaleMenuOpen(!scaleMenuOpen)
                      }}
                      className={cn(MENU_ROW, scaleMenuOpen && 'bg-stone-100')}
                    >
                      <span className={MENU_ICON}><ZoomInIcon size={14} /></span>
                      <span className="flex-1">{t('header.scale', 'Scale')}</span>
                      <span className={MENU_COUNT}>{Math.round(scaleFactor * 100)}%</span>
                    </button>

                    {/* Scale Options - nested dropdown (Compact) */}
                    {scaleMenuOpen && scaleOptionsList}

                    {/* Home Action - only show when not on home screen */}
                    {matchId && onOpenSetup && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenSetup()
                          setActionsMenuOpen(false)
                        }}
                        className={MENU_ROW}
                      >
                        <span className={MENU_ICON}><HomeIcon size={14} /></span>
                        <span>{t('common.home')}</span>
                      </button>
                    )}

                    {quitRow}
                  </div>
                )}
              </div>
            </>
          ) : (
            /* Desktop Mode: Unified hamburger menu + Fullscreen button */
            <>
              {/* Viewport Size Display - Editable (hidden by default) */}
              {showViewportSize && (
                <div className="flex items-center gap-1 whitespace-nowrap text-xs tabular-nums text-stone-500">
                  {isEditing ? (
                    <>
                      <input
                        type="number"
                        aria-label={t('header.viewportWidth', 'Viewport width')}
                        value={editingSize.width}
                        onChange={(e) => setEditingSize({ ...editingSize, width: e.target.value })}
                        onKeyDown={handleKeyDown}
                        onBlur={handleResizeViewport}
                        autoFocus
                        className="h-7 w-[60px] rounded-md border border-stone-300 bg-white px-1 text-center text-xs text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500"
                      />
                      <span>×</span>
                      <input
                        type="number"
                        aria-label={t('header.viewportHeight', 'Viewport height')}
                        value={editingSize.height}
                        onChange={(e) => setEditingSize({ ...editingSize, height: e.target.value })}
                        onKeyDown={handleKeyDown}
                        onBlur={handleResizeViewport}
                        className="h-7 w-[60px] rounded-md border border-stone-300 bg-white px-1 text-center text-xs text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500"
                      />
                    </>
                  ) : (
                    <span
                      onClick={() => {
                        setEditingSize({
                          width: viewportSize.width.toString(),
                          height: viewportSize.height.toString()
                        })
                        setIsEditing(true)
                      }}
                      className="cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-stone-100 hover:text-stone-800"
                      title={t('header.clickToEditViewport')}
                    >
                      {viewportSize.width} × {viewportSize.height}
                    </span>
                  )}
                </div>
              )}

              {/* Help Button */}
              {helpButton}

              {fullscreenButton}

              {/* Unified Menu Button (hamburger) */}
              <div ref={actionsMenuRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  aria-expanded={actionsMenuOpen}
                  onClick={(e) => {
                    e.stopPropagation()
                    setActionsMenuOpen(!actionsMenuOpen)
                    setLanguageMenuOpen(false)
                    setScaleMenuOpen(false)
                  }}
                  className={cn(HEADER_BTN, 'w-9 px-0', actionsMenuOpen && HEADER_BTN_ON)}
                  aria-label={t('header.menu', 'Menu')}
                  title={t('header.menu', 'Menu')}
                >
                  {actionsMenuOpen ? <X size={16} aria-hidden="true" /> : <Menu size={16} aria-hidden="true" />}
                </button>

                {/* Unified Actions Menu */}
                {/* Stays mounted while closed (hidden): the account dialogs opened from
                    it (login, profile, my matches) belong to its UserButton. */}
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className={cn('absolute right-0 top-full mt-1.5 min-w-[240px] max-h-[calc(100vh-56px)] flex-col overflow-y-auto', actionsMenuOpen ? 'flex' : 'hidden', MENU_PANEL)}
                    style={{ zIndex: 1000 }}
                  >
                    {/* Home Action - only show when not on home screen */}
                    {matchId && onOpenSetup && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenSetup()
                          setActionsMenuOpen(false)
                        }}
                        className={MENU_ROW}
                      >
                        <span className={MENU_ICON}><HomeIcon size={14} /></span>
                        <span>{t('common.home')}</span>
                      </button>
                    )}

                    {/* Login / account rows - hidden in offline mode. Inline, not a
                        nested dropdown: the panel's scroll box clipped it. */}
                    {!offlineMode && (
                      <UserButton inline inMatch={!!matchId} onAction={() => setActionsMenuOpen(false)} />
                    )}

                    {/* Divider */}
                    <div className={MENU_SEP} />

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setLanTabletsOpen(true)
                        setActionsMenuOpen(false)
                      }}
                      className={MENU_ROW}
                      data-testid="header-connect-tablets"
                    >
                      <span className={MENU_ICON}><Tablet size={15} /></span>
                      <span>{t('connectTablets.title', 'Connect tablets')}</span>
                    </button>

                    {/* Language Selector */}
                    <button
                      type="button"
                      aria-expanded={languageMenuOpen}
                      onClick={(e) => {
                        e.stopPropagation()
                        setLanguageMenuOpen(!languageMenuOpen)
                      }}
                      className={cn(MENU_ROW, languageMenuOpen && 'bg-stone-100')}
                    >
                      <span className={MENU_ICON}><CurrentFlag /></span>
                      <span className="flex-1">{t('header.language', 'Language')}</span>
                      <ChevronDown size={14} aria-hidden="true" className={cn('text-stone-400 transition-transform', languageMenuOpen && 'rotate-180')} />
                    </button>

                    {/* Language Options - nested */}
                    {languageMenuOpen && languageOptions}

                    {/* Display Scale Selector */}
                    <button
                      type="button"
                      aria-expanded={scaleMenuOpen}
                      onClick={(e) => {
                        e.stopPropagation()
                        setScaleMenuOpen(!scaleMenuOpen)
                      }}
                      className={cn(MENU_ROW, scaleMenuOpen && 'bg-stone-100')}
                    >
                      <span className={MENU_ICON}><ZoomInIcon size={14} /></span>
                      <span className="flex-1">{t('header.scale', 'Scale')}</span>
                      <span className={MENU_COUNT}>{Math.round(scaleFactor * 100)}%</span>
                      <ChevronDown size={14} aria-hidden="true" className={cn('text-stone-400 transition-transform', scaleMenuOpen && 'rotate-180')} />
                    </button>

                    {/* Scale Options - nested */}
                    {scaleMenuOpen && scaleOptionsList}

                    {/* Version (about) */}
                    <div className={cn(MENU_ROW, 'cursor-default text-stone-500 hover:bg-transparent')} data-testid="header-version">
                      <span className={MENU_ICON}><ClipboardIcon size={14} /></span>
                      <span className="flex-1 tabular-nums">{t('header.versionLabel', 'Version {{version}}', { version: currentVersion })}</span>
                    </div>

                    {quitRow && <div className={MENU_SEP} />}

                    {quitRow}
                  </div>

              </div>
            </>
          )}
        </div>

      </div>
      {lanTabletsOpen && <ConnectTabletsModal open onClose={() => setLanTabletsOpen(false)} match={currentMatch || null} />}
      {/* Show thin expand bar when header is collapsed */}
      {effectivelyCollapsed && (
        <div
          onClick={() => setIsCollapsed(false)}
          className="flex h-4 w-full cursor-pointer items-center justify-center border-b border-stone-200/70 bg-white text-stone-400 transition-colors hover:bg-stone-100"
        >
          <ChevronDown size={12} aria-hidden="true" />
        </div>
      )}
    </div>
  )
}
