import ConnectionStatus from './ConnectionStatus'

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
          marginTop: '8px',
          padding: '12px 16px',
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
        position: 'relative'
      }}>
        <button
          data-match-info-menu
          onClick={(e) => {
            e.stopPropagation()
            setMatchInfoMenuOpen(!matchInfoMenuOpen)
          }}
          style={{
            padding: '6px 12px',
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
        {/* Version */}
        <div className="header-version" style={{ 
          fontSize: 'clamp(10px, 1.2vw, 12px)', 
          color: 'rgba(255, 255, 255, 0.6)',
          whiteSpace: 'nowrap'
        }}>
          Version {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0'}
        </div>
        
        {/* Fullscreen Button */}
        <button
          className="header-fullscreen-btn"
          onClick={(e) => {
            e.stopPropagation()
            toggleFullscreen()
          }}
          style={{
            padding: '0 clamp(8px, 1.5vw, 16px)',
            fontSize: 'clamp(10px, 1.2vw, 12px)',
            fontWeight: 600,
            background: 'rgba(255, 255, 255, 0.1)',
            color: '#fff',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'all 0.2s',
            minHeight: '20px',
            height: '80%',
            minWidth: '60px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            whiteSpace: 'nowrap',
            width: 'auto'
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

