import { useState } from 'react'
import ConnectionStatus from './ConnectionStatus'
import changelog from '../CHANGELOG'

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
  toggleFullscreen
}) {
  const [versionMenuOpen, setVersionMenuOpen] = useState(false)
  // Use changelog as source of truth (first entry = latest version)
  const currentVersion = changelog[0]?.version || '1.0.0'

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
          Match {(matchData.match.gameNumber || matchData.match.game_n) ? (matchData.match.gameNumber || matchData.match.game_n) : 'Not set'}
        </div>
        
        {/* Teams */}
        <div style={{ fontSize: '13px', color: 'rgba(255, 255, 255, 0.9)', textAlign: 'center', fontWeight: 500 }}>
          {(matchData.homeTeam?.name && matchData.awayTeam?.name) 
            ? `${matchData.homeTeam.name} - ${matchData.awayTeam.name}`
            : 'Not set'}
        </div>
        
        {/* Date and Time */}
        <div style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.7)', textAlign: 'center' }}>
          {matchData.match.scheduledAt ? (
            (() => {
              try {
                const date = new Date(matchData.match.scheduledAt)
                return date.toLocaleDateString('en-CH', { 
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false
                })
              } catch {
                return matchData.match.scheduledAt
              }
            })()
          ) : 'Not set'}
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
          {matchData.match.test ? 'TEST' : (matchData.match.gamePin || 'N/A')}
        </div>
      </div>
    )
  }

  const renderMatchInfoButton = (match) => {
    const isTest = match?.test
    const matchNumber = match?.gameNumber || match?.game_n || 'N/A'
    const buttonText = isTest ? 'TEST MATCH' : `MATCH #${matchNumber}`

    return (
      <div style={{
        flex: '1 1 auto',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        position: 'relative',
        width: 'auto',
        height: '80%'
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
        
        {/* Collapsible Match Info Menu */}
        {matchInfoMenuOpen && matchInfoData && renderMatchInfoMenu(match, matchInfoData)}
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex',
      height: '40px',
      minHeight: '40px',
      maxHeight: '40px',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '0 clamp(8px, 2vw, 20px)',
      background: 'rgba(0, 0, 0, 0.2)',
      borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
      flexShrink: 0,
      gap: 'clamp(8px, 1.5vw, 16px)',
      zIndex: 100,
      position: 'sticky',
      top: 0
    }}>
      {/* Left: Connection Status */}
      <div style={{ flex: '0 0 auto' }}>
        <ConnectionStatus
          connectionStatuses={connectionStatuses}
          connectionDebugInfo={connectionDebugInfo}
          position="left"
          size="normal"
        />
      </div>

      {/* Center: Collapsible Match Info Menu or Match Status Banner */}
      {(showMatchSetup || matchId) && currentMatch ? (
        renderMatchInfoButton(currentMatch)
      ) : !matchId && matchStatus && (currentOfficialMatch || currentTestMatch) ? (
        renderMatchInfoButton(currentOfficialMatch || currentTestMatch)
      ) : null}

      {/* Right: Version and Fullscreen */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'clamp(8px, 1.5vw, 12px)',
        flex: '0 0 auto'
      }}>
        {/* Version with Changelog Menu */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setVersionMenuOpen(!versionMenuOpen)
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
                Version History
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
                          Current
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
            padding: '2px 6px',
            width: 'auto',
            height: '30px',
            fontSize: '12px',
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
          title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
        >
          <span className="fullscreen-btn-text" style={{ fontSize: 'clamp(10px, 1.2vw, 12px)' }}>
            {isFullscreen ? '⛶ Exit' : '⛶ Fullscreen'}
          </span>
        </button>
      </div>
    </div>
  )
}

