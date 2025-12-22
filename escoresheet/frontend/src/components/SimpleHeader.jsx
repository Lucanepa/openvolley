import { useState, useEffect, useRef } from 'react'
import changelog from '../CHANGELOG'
import ConnectionStatus from './ConnectionStatus'
import DashboardOptionsMenu from './DashboardOptionsMenu'

/**
 * SimpleHeader - A simplified header component for satellite apps (Bench, Upload Roster, Livescore)
 * Matches the MainHeader styling but with reduced functionality
 */
export default function SimpleHeader({
  title,
  subtitle,
  wakeLockActive,
  toggleWakeLock,
  onBack,
  backLabel = 'Back',
  rightContent,
  connectionStatuses,
  connectionDebugInfo,
  // Connection mode props for DashboardOptionsMenu
  connectionMode,
  activeConnection,
  onConnectionModeChange,
  showConnectionOptions = false
}) {
  const [versionMenuOpen, setVersionMenuOpen] = useState(false)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const [isCollapsed, setIsCollapsed] = useState(false)
  const touchStartY = useRef(0)
  const headerRef = useRef(null)
  const currentVersion = changelog[0]?.version || '1.0.0'

  // Check if compact mode (viewport width <= 960px)
  const isCompactMode = viewportSize.width > 0 && viewportSize.width <= 960

  // Handle touch events for swipe to show/hide header in compact mode
  useEffect(() => {
    if (!isCompactMode) {
      setIsCollapsed(false)
      return
    }

    const handleTouchStart = (e) => {
      touchStartY.current = e.touches[0].clientY
    }

    const handleTouchEnd = (e) => {
      const touchEndY = e.changedTouches[0].clientY
      const deltaY = touchEndY - touchStartY.current

      if (touchStartY.current < 60 && deltaY > 30) {
        setIsCollapsed(false)
      } else if (deltaY < -50 && !isCollapsed) {
        setIsCollapsed(true)
      }
    }

    document.addEventListener('touchstart', handleTouchStart)
    document.addEventListener('touchend', handleTouchEnd)

    return () => {
      document.removeEventListener('touchstart', handleTouchStart)
      document.removeEventListener('touchend', handleTouchEnd)
    }
  }, [isCompactMode, isCollapsed])

  // Track viewport dimensions
  useEffect(() => {
    const updateViewportSize = () => {
      setViewportSize({
        width: window.innerWidth,
        height: window.innerHeight
      })
    }

    updateViewportSize()
    window.addEventListener('resize', updateViewportSize)
    return () => window.removeEventListener('resize', updateViewportSize)
  }, [])

  // Close version menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (versionMenuOpen && !e.target.closest('.version-menu-container')) {
        setVersionMenuOpen(false)
      }
    }

    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [versionMenuOpen])

  return (
    <>
      {/* Collapsed header indicator - tap to expand */}
      {isCompactMode && isCollapsed && (
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
          height: isCompactMode && isCollapsed ? '0px' : '40px',
          minHeight: isCompactMode && isCollapsed ? '0px' : '40px',
          maxHeight: isCompactMode && isCollapsed ? '0px' : '40px',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: isCompactMode && isCollapsed ? '0' : '0 clamp(8px, 2vw, 20px)',
          background: 'rgba(0, 0, 0, 0.2)',
          borderBottom: isCompactMode && isCollapsed ? 'none' : '1px solid rgba(255, 255, 255, 0.1)',
          flexShrink: 0,
          gap: 'clamp(8px, 1.5vw, 16px)',
          zIndex: 1000,
          position: 'sticky',
          top: isCompactMode && isCollapsed ? '-40px' : 0,
          overflow: isCompactMode && isCollapsed ? 'hidden' : 'visible',
          transition: 'all 0.3s ease-in-out'
        }}
      >
        {/* Left: Title and subtitle */}
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{
            fontSize: 'clamp(13px, 1.5vw, 16px)',
            fontWeight: 600,
            whiteSpace: 'nowrap'
          }}>
            {title}
          </span>
          {subtitle && (
            <span style={{
              fontSize: 'clamp(10px, 1.2vw, 12px)',
              color: 'rgba(255, 255, 255, 0.6)',
              whiteSpace: 'nowrap'
            }}>
              {subtitle}
            </span>
          )}
        </div>

        {/* Center: Version dropdown */}
        <div
          className="version-menu-container"
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 101
          }}
        >
          <button
            onClick={() => setVersionMenuOpen(!versionMenuOpen)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 10px',
              fontSize: 'clamp(10px, 1.2vw, 12px)',
              fontWeight: 600,
              background: versionMenuOpen ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
              color: 'rgba(255, 255, 255, 0.8)',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'all 0.2s',
              whiteSpace: 'nowrap'
            }}
            onMouseEnter={(e) => {
              if (!versionMenuOpen) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
            }}
            onMouseLeave={(e) => {
              if (!versionMenuOpen) e.currentTarget.style.background = 'transparent'
            }}
          >
            <span>v{currentVersion}</span>
            <span style={{
              fontSize: '8px',
              transform: versionMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s'
            }}>▼</span>
          </button>

          {/* Version dropdown menu */}
          {versionMenuOpen && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              marginTop: '4px',
              background: '#1f2937',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '8px',
              padding: '8px 0',
              minWidth: '280px',
              maxHeight: '300px',
              overflowY: 'auto',
              boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
              zIndex: 1001
            }}>
              <div style={{
                padding: '8px 12px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                marginBottom: '4px'
              }}>
                <span style={{ fontSize: '12px', fontWeight: 600 }}>Version History</span>
              </div>
              {changelog.slice(0, 10).map((entry, index) => (
                <div
                  key={entry.version}
                  style={{
                    padding: '8px 12px',
                    borderLeft: index === 0 ? '3px solid #22c55e' : '3px solid transparent',
                    background: index === 0 ? 'rgba(34, 197, 94, 0.1)' : 'transparent'
                  }}
                >
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '4px'
                  }}>
                    <span style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: index === 0 ? '#22c55e' : 'rgba(255, 255, 255, 0.9)'
                    }}>
                      v{entry.version}
                    </span>
                    <span style={{
                      fontSize: '10px',
                      color: 'rgba(255, 255, 255, 0.5)'
                    }}>
                      {entry.date}
                    </span>
                    {index === 0 && (
                      <span style={{
                        fontSize: '9px',
                        padding: '2px 6px',
                        background: 'rgba(34, 197, 94, 0.2)',
                        color: '#22c55e',
                        borderRadius: '4px',
                        fontWeight: 600
                      }}>
                        CURRENT
                      </span>
                    )}
                  </div>
                  <ul style={{
                    margin: 0,
                    padding: '0 0 0 16px',
                    fontSize: '11px',
                    color: 'rgba(255, 255, 255, 0.7)',
                    lineHeight: '1.5'
                  }}>
                    {entry.changes.slice(0, 3).map((change, i) => (
                      <li key={i}>{change}</li>
                    ))}
                    {entry.changes.length > 3 && (
                      <li style={{ color: 'rgba(255, 255, 255, 0.4)' }}>
                        +{entry.changes.length - 3} more...
                      </li>
                    )}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Connection status, Wake lock, custom content, and back button */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'clamp(8px, 1.5vw, 12px)',
          flex: '0 0 auto'
        }}>
          {/* Connection Status */}
          {connectionStatuses && Object.keys(connectionStatuses).length > 0 && (
            <ConnectionStatus
              connectionStatuses={connectionStatuses}
              connectionDebugInfo={connectionDebugInfo || {}}
              size="small"
            />
          )}

          {/* Wake Lock Toggle */}
          {toggleWakeLock && (
            <button
              onClick={toggleWakeLock}
              style={{
                padding: '4px 10px',
                fontSize: 'clamp(9px, 1.1vw, 11px)',
                fontWeight: 600,
                background: wakeLockActive ? 'rgba(34, 197, 94, 0.3)' : 'rgba(255,255,255,0.1)',
                color: wakeLockActive ? '#22c55e' : '#fff',
                border: wakeLockActive ? '1px solid rgba(34, 197, 94, 0.5)' : '1px solid rgba(255,255,255,0.2)',
                borderRadius: '6px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'all 0.2s'
              }}
              title={wakeLockActive ? 'Screen will stay on' : 'Screen may turn off'}
            >
              {wakeLockActive ? '☀️ On' : '🌙 Off'}
            </button>
          )}

          {/* Custom right content */}
          {rightContent}

          {/* Back/Disconnect button */}
          {onBack && (
            <button
              onClick={onBack}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                padding: '4px 10px',
                fontSize: 'clamp(10px, 1.2vw, 12px)',
                fontWeight: 600,
                background: 'rgba(239, 68, 68, 0.2)',
                color: '#ef4444',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: '6px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                whiteSpace: 'nowrap'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.3)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'
              }}
            >
              <span>{backLabel}</span>
            </button>
          )}

          {/* Options Menu */}
          <DashboardOptionsMenu
            showConnectionOptions={showConnectionOptions}
            connectionType={connectionMode}
            activeConnection={activeConnection}
            onConnectionChange={onConnectionModeChange}
          />
        </div>
      </div>
    </>
  )
}
