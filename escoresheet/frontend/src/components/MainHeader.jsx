import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
import ConnectionStatus from './ConnectionStatus'
import changelog from '../CHANGELOG'

// Small flag SVG components
const FlagGB = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="60" height="42" fill="#012169"/>
    <path d="M0,0 L60,42 M60,0 L0,42" stroke="#fff" strokeWidth="7"/>
    <path d="M0,0 L60,42 M60,0 L0,42" stroke="#C8102E" strokeWidth="4" clipPath="url(#gbClip)"/>
    <path d="M30,0 V42 M0,21 H60" stroke="#fff" strokeWidth="12"/>
    <path d="M30,0 V42 M0,21 H60" stroke="#C8102E" strokeWidth="7"/>
  </svg>
)

const FlagIT = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="20" height="42" fill="#009246"/>
    <rect x="20" width="20" height="42" fill="#fff"/>
    <rect x="40" width="20" height="42" fill="#CE2B37"/>
  </svg>
)

const FlagDE = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="60" height="14" fill="#000"/>
    <rect y="14" width="60" height="14" fill="#DD0000"/>
    <rect y="28" width="60" height="14" fill="#FFCE00"/>
  </svg>
)

const FlagFR = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="20" height="42" fill="#002395"/>
    <rect x="20" width="20" height="42" fill="#fff"/>
    <rect x="40" width="20" height="42" fill="#ED2939"/>
  </svg>
)

// Language options with flag components
const languages = [
  { code: 'en', Flag: FlagGB, label: 'EN' },
  { code: 'it', Flag: FlagIT, label: 'IT' },
  { code: 'de', Flag: FlagDE, label: 'DE' },
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
  dashboardServer = null, // { enabled, dashboardCount, refereePin, onOpenOptions }
  collapsible = false, // Only allow collapsing on Scoreboard page
}) {
  const { t } = useTranslation()
  const [versionMenuOpen, setVersionMenuOpen] = useState(false)
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false)
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
  const touchStartY = useRef(0)
  const headerRef = useRef(null)
  // Use changelog as source of truth (first entry = latest version)
  const currentVersion = changelog[0]?.version || '1.0.0'

  // Check if compact mode (viewport width <= 960px)
  const isCompactMode = viewportSize.width > 0 && viewportSize.width <= 960

  // Effective collapsed state - only collapse when collapsible is true
  const effectivelyCollapsed = collapsible && isCollapsed

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
        style={{
          position: 'absolute',
          top: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '8px 12px',
          background: 'rgba(0, 0, 0, 0.95)',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          borderRadius: '8px',
          minWidth: '280px',
          zIndex: 1000,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px'
        }}
      >
        {/* Match Number */}
        <div style={{ fontSize: '14px', fontWeight: 700, color: '#fff', textAlign: 'center' }}>
          {t('header.match')} {(matchData.match.gameNumber || matchData.match.game_n) ? (matchData.match.gameNumber || matchData.match.game_n) : t('header.notSet')}
        </div>

        {/* Match ID - for debugging/support */}
        {matchId && (
          <div style={{
            fontSize: '10px',
            color: 'rgba(255, 255, 255, 0.4)',
            textAlign: 'center',
            fontFamily: 'monospace'
          }}>
            ID: {matchId}
          </div>
        )}
        
        {/* Teams */}
        <div style={{ fontSize: '13px', color: 'rgba(255, 255, 255, 0.9)', textAlign: 'center', fontWeight: 500 }}>
          {(matchData.homeTeam?.name && matchData.awayTeam?.name)
            ? `${matchData.homeTeam.name} - ${matchData.awayTeam.name}`
            : t('header.notSet')}
        </div>
        
        {/* Date and Time */}
        <div style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.7)', textAlign: 'center' }}>
          {matchData.match.scheduledAt ? (
            (() => {
              try {
                const date = new Date(matchData.match.scheduledAt)
                // Display as UTC (no timezone conversion) since we store time as-entered
                return date.toLocaleDateString('en-CH', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                  timeZone: 'UTC'
                })
              } catch {
                return matchData.match.scheduledAt
              }
            })()
          ) : t('header.notSet')}
        </div>
        
        {/* PIN or TEST */}
        <div style={{ 
          fontSize: '13px', 
          textAlign: 'center',
          padding: '6px 12px',
          borderRadius: '4px',
          background: matchData.match.test ? 'rgba(251, 191, 36, 0.2)' : 'rgba(255, 255, 255, 0.1)',
          color: matchData.match.test ? '#fbbf24' : '#fff',
          fontWeight: 600,
          fontFamily: matchData.match.test ? 'inherit' : 'monospace',
          letterSpacing: matchData.match.test ? '0.5px' : '2px'
        }}>
          {matchData.match.test ? t('header.test') : (matchData.match.gamePin || 'N/A')}
        </div>
      </div>
    )
  }

  const renderMatchInfoButton = (match) => {
    const isTest = match?.test
    const matchNumber = match?.gameNumber || match?.game_n || 'N/A'
    const buttonText = isTest ? t('header.testMatch') : t('header.matchNumber', { number: matchNumber })

    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        position: 'relative',
        width: 'auto',
        height: '32px'
      }}>
        <button
          data-match-info-menu
          onClick={(e) => {
            e.stopPropagation()
            setMatchInfoMenuOpen(!matchInfoMenuOpen)
          }}
          style={{
            padding: '5px 12px',
            fontSize: 'clamp(12px, 1.2vw, 14px)',
            fontWeight: 600,
            background: 'rgba(255, 255, 255, 0.1)',
            color: isTest ? '#fbbf24' : 'rgba(255, 255, 255, 0.9)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'all 0.2s',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            width: 'auto',
            height: 'auto',
            minHeight: '20px',  
            minWidth: '100px',
            maxHeight: '30px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
          }}
        >
          <span>{buttonText}</span>
          <span style={{ fontSize: '10px', transition: 'transform 0.2s', transform: matchInfoMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>
            ▼
          </span>
        </button>
        
        {/* Collapsible Match Info Menu - hide when header is collapsed */}
        {matchInfoMenuOpen && matchInfoData && !effectivelyCollapsed && renderMatchInfoMenu(match, matchInfoData)}
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', zIndex: 1000 }}>
      {/* Collapsed header indicator - tap to expand (only when collapsible) */}
      {collapsible && isCompactMode && isCollapsed && (
        <div
          onClick={() => setIsCollapsed(false)}
          style={{
            position: 'sticky',
            top: 0,
            width: '100%',
            height: '8px',
            background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.15) 0%, transparent 100%)',
            cursor: 'pointer',
            zIndex: 999,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-end',
            paddingBottom: '2px'
          }}
        >
          <div style={{
            width: '40px',
            height: '3px',
            background: 'rgba(255, 255, 255, 0.4)',
            borderRadius: '2px'
          }} />
        </div>
      )}
      <div
        ref={headerRef}
        style={{
          display: 'flex',
          height: effectivelyCollapsed ? '0px' : '40px',
          minHeight: effectivelyCollapsed ? '0px' : '40px',
          maxHeight: effectivelyCollapsed ? '0px' : '40px',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: effectivelyCollapsed ? '0' : '0 clamp(8px, 2vw, 20px)',
          background: 'rgba(0, 0, 0, 0.2)',
          borderBottom: effectivelyCollapsed ? 'none' : '1px solid rgba(255, 255, 255, 0.1)',
          flexShrink: 0,
          gap: 'clamp(8px, 1.5vw, 16px)',
          overflow: effectivelyCollapsed ? 'hidden' : 'visible',
          transition: 'all 0.3s ease-in-out'
        }}>
      {/* Left: Online/Offline Toggle + Connection Status */}
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* Online/Offline Toggle */}
        <button
          onClick={() => setOfflineMode(!offlineMode)}
          title={offlineMode ? t('header.switchToOnline') : t('header.switchToOffline')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 8px',
            fontSize: 'clamp(9px, 1.1vw, 11px)',
            fontWeight: 600,
            background: 'transparent',
            color: offlineMode ? '#ef4444' : '#22c55e',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'all 0.2s',
            whiteSpace: 'nowrap'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
          }}
        >
          <span>{offlineMode ? t('header.offline') : t('header.online')}</span>
          {/* Toggle Switch */}
          <div
            style={{
              position: 'relative',
              width: '25px',
              height: '15px',
              borderRadius: '10px',
              background: offlineMode ? 'rgba(239, 68, 68, 0.3)' : 'rgba(34, 197, 94, 0.3)',
              border: `1px solid ${offlineMode ? 'rgba(239, 68, 68, 0.5)' : 'rgba(34, 197, 94, 0.5)'}`,
              cursor: 'pointer',
              transition: 'all 0.3s ease',
              display: 'flex',
              alignItems: 'center',
              padding: '2px'
            }}
          >
            <div
              style={{
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                background: offlineMode ? '#ef4444' : '#22c55e',
                transform: offlineMode ? 'translateX(0)' : 'translateX(9px)',
                transition: 'all 0.3s ease',
                boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)'
              }}
            />
          </div>
        </button>

        {/* Connection Status - only show in online mode */}
        {!offlineMode && (
          <ConnectionStatus
            connectionStatuses={connectionStatuses}
            connectionDebugInfo={connectionDebugInfo}
            position="left"
            size="normal"
          />
        )}

        {/* Dashboard Server Indicator */}
        {dashboardServer?.enabled && (
          <div ref={dashboardButtonRef} style={{ position: 'relative' }}>
            <button
              onClick={openDashboardMenu}
              title={`${dashboardServer.dashboardCount || 0} dashboard(s) connected${dashboardServer.refereePin ? ` | PIN: ${dashboardServer.refereePin}` : ''}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                fontSize: 'clamp(9px, 1.1vw, 11px)',
                fontWeight: 600,
                background: dashboardServer.dashboardCount > 0
                  ? 'rgba(34, 197, 94, 0.15)'
                  : 'rgba(255, 255, 255, 0.08)',
                color: dashboardServer.dashboardCount > 0 ? '#22c55e' : 'rgba(255, 255, 255, 0.7)',
                border: `1px solid ${dashboardServer.dashboardCount > 0 ? 'rgba(34, 197, 94, 0.3)' : 'rgba(255, 255, 255, 0.15)'}`,
                borderRadius: '6px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                whiteSpace: 'nowrap'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = dashboardServer.dashboardCount > 0
                  ? 'rgba(34, 197, 94, 0.25)'
                  : 'rgba(255, 255, 255, 0.15)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = dashboardServer.dashboardCount > 0
                  ? 'rgba(34, 197, 94, 0.15)'
                  : 'rgba(255, 255, 255, 0.08)'
              }}
            >
              <span style={{ fontSize: '12px' }}>&#128225;</span>
              <span>{dashboardServer.dashboardCount || 0}</span>
              {dashboardServer.refereePin && (
                <span style={{
                  padding: '2px 6px',
                  background: 'rgba(59, 130, 246, 0.2)',
                  borderRadius: '4px',
                  fontSize: 'clamp(8px, 1vw, 10px)',
                  fontFamily: 'monospace',
                  color: '#3b82f6',
                  letterSpacing: '1px'
                }}>
                  {dashboardServer.refereePin}
                </span>
              )}
              <span style={{ fontSize: '8px', marginLeft: '2px' }}>{dashboardMenuOpen ? '▲' : '▼'}</span>
            </button>

            {/* Dashboard Connection Info Dropdown */}
            {dashboardMenuOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'fixed',
                  top: `${dashboardMenuPos.top}px`,
                  right: `${dashboardMenuPos.right}px`,
                  maxWidth: 'calc(100vw - 24px)',
                  width: '280px',
                  background: 'rgba(0, 0, 0, 0.95)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  padding: '12px',
                  zIndex: 1000,
                  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.6)'
                }}
              >
                <div style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'rgba(255, 255, 255, 0.6)',
                  marginBottom: '10px',
                  paddingBottom: '6px',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
                }}>
                  {t('header.dashboardConnectionInfo')}
                </div>

                {/* Server Status */}
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                    <span style={{
                      display: 'inline-block',
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background: dashboardServer.serverRunning ? '#22c55e' : '#ef4444'
                    }}></span>
                    <span style={{ fontSize: '12px', fontWeight: 600 }}>
                      {dashboardServer.serverRunning ? t('header.serverRunning') : t('header.serverNotRunning')}
                    </span>
                  </div>
                </div>

                {/* IP Address - Prominent Display */}
                <div style={{
                  background: 'rgba(34, 197, 94, 0.1)',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                  borderRadius: '6px',
                  padding: '10px',
                  marginBottom: '12px',
                  textAlign: 'center'
                }}>
                  <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', marginBottom: '4px' }}>
                    {t('header.connectDevicesToIp')}
                  </div>
                  <div style={{ fontSize: '16px', fontWeight: 600, fontFamily: 'monospace', color: '#22c55e' }}>
                    {dashboardServer.serverIP || t('header.notAvailable')}
                    {dashboardServer.serverPort && dashboardServer.serverPort !== 80 && dashboardServer.serverPort !== 443 && (
                      <span style={{ color: 'rgba(255,255,255,0.7)' }}>:{dashboardServer.serverPort}</span>
                    )}
                  </div>
                </div>

                {/* Connection URLs */}
                {dashboardServer.serverIP && (
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.05)',
                    borderRadius: '6px',
                    padding: '10px',
                    marginBottom: '12px'
                  }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px', color: 'rgba(255,255,255,0.8)' }}>
                      {t('header.dashboardUrls')}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', fontFamily: 'monospace' }}>
                      {dashboardServer.connectionUrl && (
                        <div style={{ wordBreak: 'break-all' }}>
                          <span style={{ color: 'rgba(255,255,255,0.5)', marginRight: '4px' }}>{t('header.referee')}:</span>
                          <span>{dashboardServer.connectionUrl}/referee</span>
                        </div>
                      )}
                      {dashboardServer.connectionUrl && (
                        <div style={{ wordBreak: 'break-all' }}>
                          <span style={{ color: 'rgba(255,255,255,0.5)', marginRight: '4px' }}>{t('header.bench')}:</span>
                          <span>{dashboardServer.connectionUrl}/bench</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Connected Dashboards Count */}
                <div style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  borderRadius: '6px',
                  padding: '10px',
                  marginBottom: '12px'
                }}>
                  <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px', color: 'rgba(255,255,255,0.8)' }}>
                    {t('header.connectedDevices')}
                  </div>
                  <div style={{ display: 'flex', gap: '16px', fontSize: '12px' }}>
                    <div>
                      <span style={{ color: 'rgba(255,255,255,0.5)' }}>{t('header.total')}: </span>
                      <span style={{ fontWeight: 600 }}>{dashboardServer.dashboardCount || 0}</span>
                    </div>
                    <div>
                      <span style={{ color: 'rgba(255,255,255,0.5)' }}>{t('header.referees')}: </span>
                      <span style={{ fontWeight: 600 }}>{dashboardServer.refereeCount || 0}</span>
                    </div>
                    <div>
                      <span style={{ color: 'rgba(255,255,255,0.5)' }}>{t('header.bench')}: </span>
                      <span style={{ fontWeight: 600 }}>{dashboardServer.benchCount || 0}</span>
                    </div>
                  </div>
                </div>

                {/* PIN */}
                {dashboardServer.refereePin && (
                  <div style={{
                    background: 'rgba(59, 130, 246, 0.1)',
                    border: '1px solid rgba(59, 130, 246, 0.3)',
                    borderRadius: '6px',
                    padding: '10px',
                    marginBottom: '12px'
                  }}>
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)', marginBottom: '4px' }}>{t('header.matchPin')}</div>
                    <div style={{ fontSize: '18px', fontWeight: 600, fontFamily: 'monospace', color: '#3b82f6', letterSpacing: '2px' }}>
                      {dashboardServer.refereePin}
                    </div>
                  </div>
                )}

                {/* More Options Button */}
                <button
                  onClick={() => {
                    setDashboardMenuOpen(false)
                    dashboardServer.onOpenOptions?.()
                  }}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '12px',
                    fontWeight: 600,
                    background: 'rgba(255, 255, 255, 0.1)',
                    color: 'var(--text)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '6px',
                    cursor: 'pointer'
                  }}
                >
                  {t('header.moreOptions')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Center: Collapsible Match Info Menu - Absolutely positioned for true centering */}
      {!effectivelyCollapsed && (((showMatchSetup || matchId) && currentMatch) || (!matchId && matchStatus && (currentOfficialMatch || currentTestMatch))) ? (
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
          <div style={{ position: 'relative' }}>
            <button
              onClick={(e) => {
                e.stopPropagation()
                setActionsMenuOpen(!actionsMenuOpen)
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 10px',
                height: '32px',
                fontSize: '12px',
                fontWeight: 600,
                background: actionsMenuOpen ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                color: '#fff',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '6px',
                cursor: 'pointer',
                gap: '6px',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)'
              }}
              onMouseLeave={(e) => {
                if (!actionsMenuOpen) {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                }
              }}
            >
              <span>{isFullscreen ? t('header.exit') : t('header.fullscreen')}</span>
              <span style={{
                fontSize: '8px',
                transition: 'transform 0.2s',
                transform: actionsMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)'
              }}>
                ▼
              </span>
            </button>

            {/* Expanded Actions Menu */}
            {actionsMenuOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: '4px',
                  padding: '8px',
                  background: 'rgba(0, 0, 0, 0.95)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  minWidth: '160px',
                  zIndex: 1000,
                  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px'
                }}
              >
                {/* Fullscreen Action */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleFullscreen()
                    setActionsMenuOpen(false)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 12px',
                    fontSize: '13px',
                    fontWeight: 500,
                    background: 'rgba(255, 255, 255, 0.1)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    width: '100%',
                    textAlign: 'left'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                  }}
                >
                  <span>⛶</span>
                  <span>{isFullscreen ? t('header.exitFullscreen') : t('header.fullscreen')}</span>
                </button>

                {/* Version Action */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setVersionMenuOpen(!versionMenuOpen)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 12px',
                    fontSize: '13px',
                    fontWeight: 500,
                    background: versionMenuOpen ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
                    color: 'rgba(255, 255, 255, 0.8)',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    width: '100%',
                    textAlign: 'left'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
                  }}
                  onMouseLeave={(e) => {
                    if (!versionMenuOpen) {
                      e.currentTarget.style.background = 'transparent'
                    }
                  }}
                >
                  <span>📋</span>
                  <span>v{currentVersion}</span>
                </button>

                {/* Language Selector Action */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setLanguageMenuOpen(!languageMenuOpen)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 12px',
                    fontSize: '13px',
                    fontWeight: 500,
                    background: languageMenuOpen ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
                    color: 'rgba(255, 255, 255, 0.8)',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    width: '100%',
                    textAlign: 'left'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
                  }}
                  onMouseLeave={(e) => {
                    if (!languageMenuOpen) {
                      e.currentTarget.style.background = 'transparent'
                    }
                  }}
                >
                  {(() => { const current = languages.find(l => l.code === i18n.language); return current ? <current.Flag /> : <FlagGB /> })()}
                  <span>{languages.find(l => l.code === i18n.language)?.label || 'EN'}</span>
                </button>

                {/* Language Options - nested dropdown */}
                {languageMenuOpen && (
                  <div
                    style={{
                      padding: '8px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      borderRadius: '6px'
                    }}
                  >
                    {languages.map((lang) => (
                      <button
                        key={lang.code}
                        onClick={(e) => {
                          e.stopPropagation()
                          i18n.changeLanguage(lang.code)
                          setLanguageMenuOpen(false)
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          width: '100%',
                          padding: '6px 10px',
                          fontSize: '12px',
                          fontWeight: i18n.language === lang.code ? 600 : 400,
                          background: i18n.language === lang.code ? 'rgba(74, 222, 128, 0.2)' : 'transparent',
                          color: i18n.language === lang.code ? '#4ade80' : '#fff',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          transition: 'all 0.2s',
                          textAlign: 'left'
                        }}
                        onMouseEnter={(e) => {
                          if (i18n.language !== lang.code) {
                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (i18n.language !== lang.code) {
                            e.currentTarget.style.background = 'transparent'
                          }
                        }}
                      >
                        <lang.Flag />
                        <span>{lang.label}</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Home Action - only show when not on home screen */}
                {matchId && onOpenSetup && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenSetup()
                      setActionsMenuOpen(false)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '8px 12px',
                      fontSize: '13px',
                      fontWeight: 500,
                      background: 'transparent',
                      color: '#22c55e',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      width: '100%',
                      textAlign: 'left'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(34, 197, 94, 0.15)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    <span>🏠</span>
                    <span>{t('common.home')}</span>
                  </button>
                )}

                {/* Version Changelog - nested dropdown */}
                {versionMenuOpen && (
                  <div
                    style={{
                      padding: '8px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      borderRadius: '6px',
                      maxHeight: '250px',
                      overflowY: 'auto'
                    }}
                  >
                    <div style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: '#fff',
                      marginBottom: '8px',
                      paddingBottom: '6px',
                      borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
                    }}>
                      {t('header.versionHistory')}
                    </div>
                    {changelog.slice(0, 5).map((release, index) => (
                      <div
                        key={release.version}
                        style={{
                          marginBottom: index < 4 ? '8px' : 0,
                          paddingBottom: index < 4 ? '8px' : 0,
                          borderBottom: index < 4 ? '1px solid rgba(255, 255, 255, 0.05)' : 'none'
                        }}
                      >
                        <div style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '4px'
                        }}>
                          <span style={{
                            fontSize: '11px',
                            fontWeight: 600,
                            color: release.version === currentVersion ? '#4ade80' : '#fff'
                          }}>
                            v{release.version}
                          </span>
                          <span style={{ fontSize: '10px', color: 'rgba(255, 255, 255, 0.4)' }}>
                            {release.date}
                          </span>
                        </div>
                        <ul style={{
                          margin: 0,
                          paddingLeft: '12px',
                          fontSize: '10px',
                          color: 'rgba(255, 255, 255, 0.6)',
                          lineHeight: '1.4'
                        }}>
                          {release.changes.slice(0, 2).map((change, i) => (
                            <li key={i} style={{ marginBottom: '1px' }}>{change}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          /* Desktop Mode: Show all actions inline */
          <>
            {/* Home Button - only show when not on home screen */}
            {matchId && onOpenSetup && (
              <button
                onClick={() => onOpenSetup()}
                title="Back to Home"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '4px 10px',
                  fontSize: 'clamp(10px, 1.2vw, 12px)',
                  fontWeight: 600,
                  background: 'rgba(34, 197, 94, 0.2)',
                  color: '#22c55e',
                  border: '1px solid rgba(34, 197, 94, 0.4)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  whiteSpace: 'nowrap',
                  gap: '4px'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(34, 197, 94, 0.3)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(34, 197, 94, 0.2)'
                }}
              >
                <span>🏠</span>
                <span>{t('common.home')}</span>
              </button>
            )}

            {/* Viewport Size Display - Editable (hidden by default) */}
            {showViewportSize && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: 'clamp(10px, 1.2vw, 12px)',
                color: 'rgba(255, 255, 255, 0.6)',
                whiteSpace: 'nowrap'
              }}>
                {isEditing ? (
                  <>
                    <input
                      type="number"
                      value={editingSize.width}
                      onChange={(e) => setEditingSize({ ...editingSize, width: e.target.value })}
                      onKeyDown={handleKeyDown}
                      onBlur={handleResizeViewport}
                      autoFocus
                      style={{
                        width: '60px',
                        fontSize: 'clamp(10px, 1.2vw, 12px)',
                        color: 'rgba(255, 255, 255, 0.9)',
                        background: 'rgba(255, 255, 255, 0.1)',
                        border: '1px solid rgba(255, 255, 255, 0.3)',
                        borderRadius: '4px',
                        padding: '2px 4px',
                        textAlign: 'center',
                        outline: 'none'
                      }}
                    />
                    <span>×</span>
                    <input
                      type="number"
                      value={editingSize.height}
                      onChange={(e) => setEditingSize({ ...editingSize, height: e.target.value })}
                      onKeyDown={handleKeyDown}
                      onBlur={handleResizeViewport}
                      style={{
                        width: '60px',
                        fontSize: 'clamp(10px, 1.2vw, 12px)',
                        color: 'rgba(255, 255, 255, 0.9)',
                        background: 'rgba(255, 255, 255, 0.1)',
                        border: '1px solid rgba(255, 255, 255, 0.3)',
                        borderRadius: '4px',
                        padding: '2px 4px',
                        textAlign: 'center',
                        outline: 'none'
                      }}
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
                    style={{
                      cursor: 'pointer',
                      padding: '2px 4px',
                      borderRadius: '4px',
                      transition: 'all 0.2s'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                      e.currentTarget.style.color = 'rgba(255, 255, 255, 0.9)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                      e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)'
                    }}
                    title="Click to edit and resize viewport"
                  >
                    {viewportSize.width} × {viewportSize.height}
                  </span>
                )}
              </div>
            )}

            {/* Language Selector */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setLanguageMenuOpen(!languageMenuOpen)
                  setVersionMenuOpen(false)
                }}
                style={{
                  fontSize: 'clamp(10px, 1.2vw, 12px)',
                  color: 'rgba(255, 255, 255, 0.6)',
                  whiteSpace: 'nowrap',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                  e.currentTarget.style.color = 'rgba(255, 255, 255, 0.9)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)'
                }}
              >
                {(() => { const current = languages.find(l => l.code === i18n.language); return current ? <current.Flag /> : <FlagGB /> })()}
                <span>{languages.find(l => l.code === i18n.language)?.label || 'EN'}</span>
                <span style={{
                  fontSize: '8px',
                  transition: 'transform 0.2s',
                  transform: languageMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)'
                }}>
                  ▼
                </span>
              </button>

              {/* Language Dropdown */}
              {languageMenuOpen && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: '4px',
                    padding: '8px',
                    background: 'rgba(0, 0, 0, 0.95)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '8px',
                    minWidth: '100px',
                    zIndex: 1000,
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
                  }}
                >
                  {languages.map((lang) => (
                    <button
                      key={lang.code}
                      onClick={(e) => {
                        e.stopPropagation()
                        i18n.changeLanguage(lang.code)
                        setLanguageMenuOpen(false)
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        width: '100%',
                        padding: '8px 12px',
                        fontSize: '13px',
                        fontWeight: i18n.language === lang.code ? 600 : 400,
                        background: i18n.language === lang.code ? 'rgba(74, 222, 128, 0.2)' : 'transparent',
                        color: i18n.language === lang.code ? '#4ade80' : '#fff',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        textAlign: 'left'
                      }}
                      onMouseEnter={(e) => {
                        if (i18n.language !== lang.code) {
                          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (i18n.language !== lang.code) {
                          e.currentTarget.style.background = 'transparent'
                        }
                      }}
                    >
                      <lang.Flag />
                      <span>{lang.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Version with Changelog Menu */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setVersionMenuOpen(!versionMenuOpen)
                  setLanguageMenuOpen(false)
                }}
                style={{
                  fontSize: 'clamp(10px, 1.2vw, 12px)',
                  color: 'rgba(255, 255, 255, 0.6)',
                  whiteSpace: 'nowrap',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                  e.currentTarget.style.color = 'rgba(255, 255, 255, 0.9)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)'
                }}
              >
                <span>v{currentVersion}</span>
                <span style={{
                  fontSize: '8px',
                  transition: 'transform 0.2s',
                  transform: versionMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)'
                }}>
                  ▼
                </span>
              </button>

              {/* Version Changelog Dropdown */}
              {versionMenuOpen && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: '4px',
                    padding: '12px',
                    background: 'rgba(0, 0, 0, 0.95)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '8px',
                    minWidth: '280px',
                    maxWidth: '350px',
                    maxHeight: '400px',
                    overflowY: 'auto',
                    zIndex: 1000,
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
                  }}
                >
                  <div style={{
                    fontSize: '14px',
                    fontWeight: 700,
                    color: '#fff',
                    marginBottom: '12px',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
                    paddingBottom: '8px'
                  }}>
                    {t('header.versionHistory')}
                  </div>

                  {changelog.map((release, index) => (
                    <div
                      key={release.version}
                      style={{
                        marginBottom: index < changelog.length - 1 ? '12px' : 0,
                        paddingBottom: index < changelog.length - 1 ? '12px' : 0,
                        borderBottom: index < changelog.length - 1 ? '1px solid rgba(255, 255, 255, 0.1)' : 'none'
                      }}
                    >
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '6px'
                      }}>
                        <span style={{
                          fontSize: '13px',
                          fontWeight: 600,
                          color: release.version === currentVersion ? '#4ade80' : '#fff'
                        }}>
                          v{release.version}
                          {release.version === currentVersion && (
                            <span style={{
                              marginLeft: '6px',
                              fontSize: '10px',
                              background: 'rgba(74, 222, 128, 0.2)',
                              padding: '2px 6px',
                              borderRadius: '4px'
                            }}>
                              {t('header.current')}
                            </span>
                          )}
                        </span>
                        <span style={{ fontSize: '11px', color: 'rgba(255, 255, 255, 0.5)' }}>
                          {release.date}
                        </span>
                      </div>
                      <ul style={{
                        margin: 0,
                        paddingLeft: '16px',
                        fontSize: '12px',
                        color: 'rgba(255, 255, 255, 0.7)',
                        lineHeight: '1.5'
                      }}>
                        {release.changes.map((change, i) => (
                          <li key={i} style={{ marginBottom: '2px' }}>{change}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Fullscreen Button */}
            <button
              className="header-fullscreen-btn"
              onClick={(e) => {
                e.stopPropagation()
                toggleFullscreen()
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 8px',
                width: 'auto',
                height: '80%',
                fontSize: 'clamp(8px, 1.2vw, 12px)',
                fontWeight: 600,
                background: 'rgba(255, 255, 255, 0.1)',
                color: '#fff',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
              }}
              title={isFullscreen ? t('header.exitFullscreen') : t('header.fullscreen')}
            >
              <span className="fullscreen-btn-text" style={{ fontSize: 'clamp(10px, 1.2vw, 12px)' }}>
                {isFullscreen ? `⛶ ${t('header.exit')}` : `⛶ ${t('header.fullscreen')}`}
              </span>
            </button>
          </>
        )}
      </div>

    </div>
    {/* Collapse/Expand button at bottom center - only shown when collapsible */}
    {/* Uses drag handle style on touch devices, arrow on desktop */}
    {collapsible && (
      <div
        onClick={() => setIsCollapsed(!isCollapsed)}
        onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
        onMouseLeave={(e) => e.currentTarget.style.opacity = '0.25'}
        style={{
          position: 'absolute',
          top: isCollapsed ? '0' : '40px',
          left: '50%',
          transform: 'translateX(-50%)',
          width: isCompactMode ? '60px' : '40px',
          height: isCompactMode ? '20px' : '24px',
          background: '#22c55e',
          borderRadius: '0 0 8px 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: '3px',
          cursor: isCompactMode ? 'grab' : 'pointer',
          zIndex: 1001,
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
          transition: 'all 0.2s ease',
          opacity: 0.25
        }}
      >
        {isCompactMode ? (
          /* Drag handle for touch - horizontal line like iOS sheet handle */
          <div style={{
            width: '32px',
            height: '4px',
            background: 'rgba(0, 0, 0, 0.4)',
            borderRadius: '2px'
          }} />
        ) : (
          /* Arrow for desktop */
          <span style={{
            fontSize: '14px',
            color: '#000',
            fontWeight: 700,
            transform: isCollapsed ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease'
          }}>
            ▲
          </span>
        )}
      </div>
    )}
    </div>
  )
}

