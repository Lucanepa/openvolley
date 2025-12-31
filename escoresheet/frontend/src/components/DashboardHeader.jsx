import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import changelog from '../CHANGELOG'
import ConnectionStatus from './ConnectionStatus'
import DashboardOptionsMenu from './DashboardOptionsMenu'

/**
 * DashboardHeader - Shared header for dashboard views (Referee, Bench, Livescore)
 * Used when selecting a match, before connecting to a specific game
 */
export default function DashboardHeader({
  title,
  subtitle,
  connectionStatuses = {},
  connectionDebugInfo = {},
  // Match loading
  onLoadGames,
  loadingMatches = false,
  matchCount = 0,
  // Optional features
  showFullscreen = false,
  isFullscreen = false,
  onToggleFullscreen,
  // Wake lock
  showWakeLock = false,
  wakeLockActive = false,
  onToggleWakeLock,
  // Back button
  onBack,
  backLabel,
  // Options menu
  showOptionsMenu = true,
  connectionMode,
  activeConnection,
  onConnectionModeChange,
  // Custom content
  rightContent
}) {
  const { t } = useTranslation()
  const currentVersion = changelog[0]?.version || '1.0.0'
  const [versionMenuOpen, setVersionMenuOpen] = useState(false)

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
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 16px',
      background: 'rgba(0, 0, 0, 0.3)',
      borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
      gap: '12px',
      flexWrap: 'wrap'
    }}>
      {/* Left: Title and subtitle */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flex: '0 0 auto'
      }}>
        <span style={{
          fontSize: '16px',
          fontWeight: 600
        }}>
          {title}
        </span>
        {subtitle && (
          <span style={{
            fontSize: '12px',
            color: 'rgba(255, 255, 255, 0.6)'
          }}>
            {subtitle}
          </span>
        )}
      </div>

      {/* Center: Connection Status */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flex: '1 1 auto',
        justifyContent: 'center'
      }}>
        <ConnectionStatus
          connectionStatuses={connectionStatuses}
          connectionDebugInfo={connectionDebugInfo}
          size="small"
        />
      </div>

      {/* Right: Actions */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flex: '0 0 auto'
      }}>
        {/* Load Games Button */}
        {onLoadGames && (
          <button
            onClick={onLoadGames}
            disabled={loadingMatches}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 600,
              background: loadingMatches ? 'rgba(255, 255, 255, 0.05)' : 'rgba(59, 130, 246, 0.2)',
              color: loadingMatches ? 'rgba(255, 255, 255, 0.4)' : '#3b82f6',
              border: '1px solid rgba(59, 130, 246, 0.5)',
              borderRadius: '6px',
              cursor: loadingMatches ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.2s'
            }}
          >
            {loadingMatches ? '...' : '🔄'} {t('refereeDashboard.loadGames', 'Load Games')}
          </button>
        )}

        {/* Match Count Badge */}
        {matchCount > 0 && (
          <div style={{
            fontSize: '12px',
            padding: '4px 10px',
            background: 'rgba(34, 197, 94, 0.2)',
            border: '1px solid rgba(34, 197, 94, 0.5)',
            borderRadius: '6px',
            fontWeight: 600,
            color: '#22c55e'
          }}>
            {matchCount} {matchCount === 1 ? t('refereeDashboard.game', 'game') : t('refereeDashboard.games', 'games')}
          </div>
        )}

        {/* Version Dropdown */}
        <div className="version-menu-container" style={{ position: 'relative' }}>
          <button
            onClick={() => setVersionMenuOpen(!versionMenuOpen)}
            style={{
              padding: '4px 10px',
              fontSize: '12px',
              fontWeight: 600,
              background: versionMenuOpen ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.1)',
              color: 'rgba(255, 255, 255, 0.8)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              transition: 'all 0.2s'
            }}
          >
            v{currentVersion}
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
              right: 0,
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

        {/* Wake Lock Toggle */}
        {showWakeLock && onToggleWakeLock && (
          <button
            onClick={onToggleWakeLock}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 600,
              background: wakeLockActive ? 'rgba(34, 197, 94, 0.3)' : 'rgba(255, 255, 255, 0.1)',
              color: wakeLockActive ? '#22c55e' : '#fff',
              border: wakeLockActive ? '1px solid rgba(34, 197, 94, 0.5)' : '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            title={wakeLockActive ? 'Screen will stay on' : 'Screen may turn off'}
          >
            {wakeLockActive ? '☀️' : '🌙'}
          </button>
        )}

        {/* Fullscreen Toggle */}
        {showFullscreen && onToggleFullscreen && (
          <button
            onClick={onToggleFullscreen}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.1)',
              color: '#fff',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            {isFullscreen ? '⛶' : '⛶'}
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
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 600,
              background: 'rgba(239, 68, 68, 0.2)',
              color: '#ef4444',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            {backLabel || t('common.back', 'Back')}
          </button>
        )}

        {/* Options Menu */}
        {showOptionsMenu && (
          <DashboardOptionsMenu
            showConnectionOptions={!!onConnectionModeChange}
            connectionType={connectionMode}
            activeConnection={activeConnection}
            onConnectionChange={onConnectionModeChange}
          />
        )}
      </div>
    </div>
  )
}
