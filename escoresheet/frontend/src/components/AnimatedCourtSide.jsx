import { useState, useEffect, useRef, useMemo } from 'react'

// Position coordinates as percentages - for left side of court
// Volleyball positions: IV=front-left, III=front-center, II=front-right, V=back-left, VI=back-center, I=back-right
const POSITION_COORDS = {
  // Front row (closer to net, top of court view)
  IV: { x: 16, y: 25 },
  III: { x: 50, y: 25 },
  II: { x: 84, y: 25 },
  // Back row (further from net, bottom of court view)
  V: { x: 16, y: 75 },
  VI: { x: 50, y: 75 },
  I: { x: 84, y: 75 },
}

// Rotation order: clockwise I -> VI -> V -> IV -> III -> II -> I
const ROTATION_ORDER = ['I', 'VI', 'V', 'IV', 'III', 'II']

// Check if lineup changed due to rotation (all players shifted by one position)
function isRotation(prevLineup, currentLineup) {
  if (!prevLineup || !currentLineup) return false
  if (Object.keys(prevLineup).length !== 6 || Object.keys(currentLineup).length !== 6) return false

  // Check if each player moved to the next position in rotation order
  let rotationMatches = 0
  for (let i = 0; i < ROTATION_ORDER.length; i++) {
    const currentPos = ROTATION_ORDER[i]
    const nextPos = ROTATION_ORDER[(i + 1) % 6]

    if (prevLineup[currentPos] === currentLineup[nextPos]) {
      rotationMatches++
    }
  }

  // All 6 players should have moved to next position
  return rotationMatches === 6
}

// Build a simple lineup map: position -> playerNumber
function buildLineupMap(playersOnCourt) {
  const map = {}
  if (!playersOnCourt) return map
  for (const player of playersOnCourt) {
    if (player.position && player.number) {
      map[player.position] = player.number
    }
  }
  return map
}

export default function AnimatedCourtSide({
  playersOnCourt,
  teamKey,
  teamColor,
  onPlayerClick,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  getPlayerSanctions,
  recentlySubstitutedPlayers,
  draggedPlayer,
  dropTargetPosition,
  servingPosition, // Which position has serve ball (e.g., 'I')
  mikasaVolleyball,
  resolveReplacementNumber,
  activeReplacements,
  getReplacementBadgeStyle,
  courtCaptain,
  data,
  expandedPlayerName,
  onPlayerNameClick,
  showNamesOnCourt,
  getCourtPlayerDisplayName,
  leftCourtPositionVRef,
  rallyStatus,
  isRallyReplayed,
  lineupSet,
  substitutionsUsed,
  children, // For blur overlay or other content to render inside court-team
}) {
  const [isAnimating, setIsAnimating] = useState(false)
  const [animatedPositions, setAnimatedPositions] = useState({}) // playerNumber -> {x, y}
  const prevLineupRef = useRef(null)
  const animationTimeoutRef = useRef(null)

  // Current lineup map
  const currentLineup = useMemo(() => buildLineupMap(playersOnCourt), [playersOnCourt])

  // Detect rotation and trigger animation
  useEffect(() => {
    const prevLineup = prevLineupRef.current

    if (prevLineup && isRotation(prevLineup, currentLineup)) {
      // Start animation - set initial positions (where players WERE)
      const initialPositions = {}
      for (const [pos, playerNum] of Object.entries(prevLineup)) {
        initialPositions[playerNum] = { ...POSITION_COORDS[pos] }
      }
      setAnimatedPositions(initialPositions)
      setIsAnimating(true)

      // After a tick, update to final positions (where players ARE NOW)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const finalPositions = {}
          for (const [pos, playerNum] of Object.entries(currentLineup)) {
            finalPositions[playerNum] = { ...POSITION_COORDS[pos] }
          }
          setAnimatedPositions(finalPositions)
        })
      })

      // End animation after transition completes
      animationTimeoutRef.current = setTimeout(() => {
        setIsAnimating(false)
        setAnimatedPositions({})
      }, 450) // Match CSS transition duration
    }

    prevLineupRef.current = { ...currentLineup }

    return () => {
      if (animationTimeoutRef.current) {
        clearTimeout(animationTimeoutRef.current)
      }
    }
  }, [currentLineup])

  // If animating, render with absolute positioning
  if (isAnimating && Object.keys(animatedPositions).length > 0) {
    return (
      <div
        className="court-team court-team-left"
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
        }}
      >
        {playersOnCourt.map((player, idx) => {
          const pos = animatedPositions[player.number]
          if (!pos) return null

          const sanctions = getPlayerSanctions?.(teamKey, player.number) || []
          const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
          const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
          const isRecentlySub = recentlySubstitutedPlayers?.some(
            sub => sub.team === teamKey && String(sub.playerNumber) === String(player.number)
          )

          return (
            <div
              key={`animated-${player.number}-${idx}`}
              className="court-player"
              style={{
                position: 'absolute',
                left: `${pos.x}%`,
                top: `${pos.y}%`,
                transform: 'translate(-50%, -50%)',
                transition: 'left 0.4s ease-in-out, top 0.4s ease-in-out',
                background: isRecentlySub ? '#86efac' : player.isLibero ? '#FFF8E7' : undefined,
                color: isRecentlySub ? '#000' : player.isLibero ? '#000' : undefined,
                zIndex: 10,
              }}
            >
              <span className="court-player-position">{player.position}</span>
              {player.isCaptain && (
                <span className="court-player-captain" style={player.isLibero ? { background: '#fff', color: '#10b981', borderColor: '#10b981' } : undefined}>C</span>
              )}
              {player.number}
            </div>
          )
        })}
      </div>
    )
  }

  // Helper to determine if a player can be substituted
  const canPlayerSubstitute = (player) => {
    const teamSubstitutions = substitutionsUsed || 0
    return rallyStatus === 'idle' && !isRallyReplayed && lineupSet &&
      player.number && player.number !== '' && !player.isPlaceholder && teamSubstitutions < 6
  }

  // Normal rendering (grid-based, same as original)
  return (
    <div className="court-team court-team-left">
      <div className="court-row court-row-front">
        {playersOnCourt.slice(0, 3).map((player, idx) => {
          const playerCanSub = canPlayerSubstitute(player)
          const replacementNumber = resolveReplacementNumber?.(player, activeReplacements)
          const isRecentlySub = recentlySubstitutedPlayers?.some(
            sub => sub.team === teamKey && String(sub.playerNumber) === String(player.number)
          )
          const sanctions = getPlayerSanctions?.(teamKey, player.number) || []
          const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
          const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
          const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
          const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')
          const isDropTarget = dropTargetPosition?.team === teamKey && dropTargetPosition?.position === player.position
          const isDragging = draggedPlayer?.type === 'court' && draggedPlayer?.team === teamKey && draggedPlayer?.position === player.position

          return (
            <div
              key={`${teamKey}-court-front-${player.position}-${player.id || player.number || idx}`}
              className={`court-player${isRecentlySub ? ' recently-substituted' : ''}`}
              draggable={playerCanSub && !player.isLibero}
              onDragStart={(e) => playerCanSub && onDragStart?.(e, teamKey, player.position, player.number, player.isLibero)}
              onDragEnd={onDragEnd}
              onClick={(e) => onPlayerClick?.(teamKey, player.position, player.number, e)}
              onDragOver={(e) => onDragOver?.(e, teamKey, player.position)}
              onDragLeave={onDragLeave}
              onDrop={(e) => onDrop?.(e, teamKey, player.position, player.number)}
              style={{
                cursor: playerCanSub && !player.isLibero ? 'grab' : 'pointer',
                opacity: isDragging ? 0.5 : undefined,
                transition: 'transform 0.2s, background 0.15s, box-shadow 0.15s',
                background: isDropTarget ? 'rgba(74, 222, 128, 0.4)' : isRecentlySub ? '#86efac' : player.isLibero ? '#FFF8E7' : undefined,
                color: isRecentlySub ? '#000' : player.isLibero ? '#000' : undefined,
                position: 'relative',
                animation: isRecentlySub ? 'recentSubFlash 0.5s ease-in-out infinite' : undefined,
                fontWeight: isRecentlySub ? 900 : undefined,
                border: isDropTarget ? '3px solid #4ade80' : isRecentlySub ? '3px solid #22c55e' : undefined,
                boxShadow: isDropTarget ? '0 0 12px rgba(74, 222, 128, 0.5)' : undefined
              }}
              onMouseEnter={(e) => {
                if (!isDropTarget) {
                  e.currentTarget.style.transform = 'scale(1.05)'
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(255,255,255,0.2)'
                }
              }}
              onMouseLeave={(e) => {
                if (!isDropTarget) {
                  e.currentTarget.style.transform = 'scale(1)'
                  e.currentTarget.style.boxShadow = 'none'
                }
              }}
            >
              {replacementNumber && (
                <span style={getReplacementBadgeStyle?.(player)}>
                  {replacementNumber}
                </span>
              )}
              <span className="court-player-position">{player.position}</span>
              {player.isCaptain && (() => {
                if (player.isLibero) {
                  return <span className="court-player-captain" style={{ background: '#fff', color: '#10b981', borderColor: '#10b981' }}>C</span>
                }
                return <span className="court-player-captain">C</span>
              })()}
              {courtCaptain && Number(courtCaptain) === Number(player.number) && !player.isCaptain && (
                <span className="court-player-captain" style={{ color: '#fbbf24', borderColor: '#fbbf24' }}>C</span>
              )}
              {player.isLibero && !player.isCaptain && (() => {
                const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
                const liberoCount = teamPlayers?.filter(p => p.libero === 'libero1' || p.libero === 'libero2' || p.libero === 'redesignated').length || 0
                const liberoLabel = liberoCount === 1 ? 'L' : (player.liberoType === 'libero1' ? 'L1' : player.liberoType === 'redesignated' ? 'LR' : 'L2')
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
              {sanctions.length > 0 && (
                <div style={{
                  position: 'absolute',
                  bottom: '-3px',
                  right: '-6px',
                  zIndex: 10
                }}>
                  {hasExpulsion ? (
                    <div style={{ position: 'relative', width: '12px', height: '12px' }}>
                      <div className="sanction-card yellow" style={{ width: '6px', height: '9px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', position: 'absolute', left: '0', top: '1px', transform: 'rotate(-8deg)' }} />
                      <div className="sanction-card red" style={{ width: '6px', height: '9px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', position: 'absolute', left: '5px', top: '1px', transform: 'rotate(8deg)' }} />
                    </div>
                  ) : hasDisqualification ? (
                    <div className="sanction-card red" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)' }} />
                  ) : hasPenalty ? (
                    <div className="sanction-card red" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)' }} />
                  ) : hasWarning ? (
                    <div className="sanction-card yellow" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)' }} />
                  ) : null}
                </div>
              )}
              {showNamesOnCourt && player.number && (
                <div
                  onClick={(e) => {
                    e.stopPropagation()
                    onPlayerNameClick?.(teamKey, player.number, e)
                  }}
                  style={{
                    position: 'absolute',
                    bottom: '-18px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'rgba(0, 0, 0, 0.85)',
                    border: '1px solid rgba(255, 255, 255, 0.3)',
                    borderRadius: '3px',
                    padding: '1px 4px',
                    fontSize: '9px',
                    fontWeight: 600,
                    color: '#fff',
                    whiteSpace: 'nowrap',
                    minWidth: '68px',
                    zIndex: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.3px',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '2px'
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                    <span style={{ fontSize: '7px', opacity: 0.7, transform: expandedPlayerName === `${teamKey}-${player.number}` ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▼</span>
                    {expandedPlayerName === `${teamKey}-${player.number}`
                      ? `#${player.number}`
                      : getCourtPlayerDisplayName?.(teamKey, player.number, player.firstName, player.lastName)}
                  </div>
                  {expandedPlayerName === `${teamKey}-${player.number}` && (
                    <div style={{ fontSize: '8px', opacity: 0.9, borderTop: '1px solid rgba(255,255,255,0.2)', paddingTop: '2px', marginTop: '1px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div>{player.firstName}</div>
                      <div>{player.lastName}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="court-row court-row-back">
        {playersOnCourt.slice(3, 6).map((player, idx) => {
          const shouldShowBall = player.position === servingPosition
          const playerCanSub = canPlayerSubstitute(player)
          const replacementNumber = resolveReplacementNumber?.(player, activeReplacements)
          const isRecentlySub = recentlySubstitutedPlayers?.some(
            sub => sub.team === teamKey && String(sub.playerNumber) === String(player.number)
          )
          const sanctions = getPlayerSanctions?.(teamKey, player.number) || []
          const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
          const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
          const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
          const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')
          const isDropTarget = dropTargetPosition?.team === teamKey && dropTargetPosition?.position === player.position
          const isDragging = draggedPlayer?.type === 'court' && draggedPlayer?.team === teamKey && draggedPlayer?.position === player.position
          const canDragCourtPlayer = playerCanSub || player.isLibero

          return (
            <div
              key={`${teamKey}-court-back-${player.position}-${player.id || player.number || idx}`}
              ref={player.position === 'V' ? leftCourtPositionVRef : undefined}
              className={`court-player${isRecentlySub ? ' recently-substituted' : ''}`}
              draggable={canDragCourtPlayer}
              onDragStart={(e) => canDragCourtPlayer && onDragStart?.(e, teamKey, player.position, player.number, player.isLibero)}
              onDragEnd={onDragEnd}
              onClick={(e) => onPlayerClick?.(teamKey, player.position, player.number, e)}
              onDragOver={(e) => onDragOver?.(e, teamKey, player.position)}
              onDragLeave={onDragLeave}
              onDrop={(e) => onDrop?.(e, teamKey, player.position, player.number)}
              style={{
                position: 'relative',
                cursor: canDragCourtPlayer ? 'grab' : (player.number && player.number !== '' ? 'pointer' : 'default'),
                opacity: isDragging ? 0.5 : undefined,
                transition: 'transform 0.2s, background 0.15s, box-shadow 0.15s',
                background: isDropTarget ? 'rgba(74, 222, 128, 0.4)' : isRecentlySub ? '#86efac' : player.isLibero ? '#FFF8E7' : undefined,
                color: isRecentlySub ? '#000' : player.isLibero ? '#000' : undefined,
                animation: isRecentlySub ? 'recentSubFlash 0.5s ease-in-out infinite' : undefined,
                fontWeight: isRecentlySub ? 900 : undefined,
                border: isDropTarget ? '3px solid #4ade80' : isRecentlySub ? '3px solid #22c55e' : undefined,
                boxShadow: isDropTarget ? '0 0 12px rgba(74, 222, 128, 0.5)' : undefined
              }}
              onMouseEnter={(e) => {
                if (player.number && player.number !== '' && !isDropTarget) {
                  e.currentTarget.style.transform = 'scale(1.05)'
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(255,255,255,0.2)'
                }
              }}
              onMouseLeave={(e) => {
                if (player.number && player.number !== '' && !isDropTarget) {
                  e.currentTarget.style.transform = 'scale(1)'
                  e.currentTarget.style.boxShadow = 'none'
                }
              }}
            >
              {shouldShowBall && mikasaVolleyball && (
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
                <span style={getReplacementBadgeStyle?.(player)}>
                  {replacementNumber}
                </span>
              )}
              <span className="court-player-position">{player.position}</span>
              {player.isCaptain && (() => {
                if (player.isLibero) {
                  return <span className="court-player-captain" style={{ background: '#fff', color: '#10b981', borderColor: '#10b981' }}>C</span>
                }
                return <span className="court-player-captain">C</span>
              })()}
              {courtCaptain && Number(courtCaptain) === Number(player.number) && !player.isCaptain && (
                <span className="court-player-captain" style={{ color: '#fbbf24', borderColor: '#fbbf24' }}>C</span>
              )}
              {player.isLibero && !player.isCaptain && (() => {
                const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
                const liberoCount = teamPlayers?.filter(p => p.libero === 'libero1' || p.libero === 'libero2' || p.libero === 'redesignated').length || 0
                const liberoLabel = liberoCount === 1 ? 'L' : (player.liberoType === 'libero1' ? 'L1' : player.liberoType === 'redesignated' ? 'LR' : 'L2')
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
              {sanctions.length > 0 && (
                <div style={{
                  position: 'absolute',
                  bottom: '-3px',
                  right: '-6px',
                  zIndex: 10
                }}>
                  {hasExpulsion ? (
                    <div style={{ position: 'relative', width: '12px', height: '12px' }}>
                      <div className="sanction-card yellow" style={{ width: '6px', height: '9px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', position: 'absolute', left: '0', top: '1px', transform: 'rotate(-8deg)' }} />
                      <div className="sanction-card red" style={{ width: '6px', height: '9px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', position: 'absolute', left: '5px', top: '1px', transform: 'rotate(8deg)' }} />
                    </div>
                  ) : hasDisqualification ? (
                    <div className="sanction-card red" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)' }} />
                  ) : hasPenalty ? (
                    <div className="sanction-card red" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)' }} />
                  ) : hasWarning ? (
                    <div className="sanction-card yellow" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)' }} />
                  ) : null}
                </div>
              )}
              {showNamesOnCourt && player.number && (
                <div
                  onClick={(e) => {
                    e.stopPropagation()
                    onPlayerNameClick?.(teamKey, player.number, e)
                  }}
                  style={{
                    position: 'absolute',
                    bottom: '-18px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'rgba(0, 0, 0, 0.85)',
                    border: '1px solid rgba(255, 255, 255, 0.3)',
                    borderRadius: '3px',
                    padding: '1px 4px',
                    fontSize: '9px',
                    fontWeight: 600,
                    color: '#fff',
                    whiteSpace: 'nowrap',
                    minWidth: '68px',
                    zIndex: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.3px',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '2px'
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                    <span style={{ fontSize: '7px', opacity: 0.7, transform: expandedPlayerName === `${teamKey}-${player.number}` ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▼</span>
                    {expandedPlayerName === `${teamKey}-${player.number}`
                      ? `#${player.number}`
                      : getCourtPlayerDisplayName?.(teamKey, player.number, player.firstName, player.lastName)}
                  </div>
                  {expandedPlayerName === `${teamKey}-${player.number}` && (
                    <div style={{ fontSize: '8px', opacity: 0.9, borderTop: '1px solid rgba(255,255,255,0.2)', paddingTop: '2px', marginTop: '1px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div>{player.firstName}</div>
                      <div>{player.lastName}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {children}
    </div>
  )
}
