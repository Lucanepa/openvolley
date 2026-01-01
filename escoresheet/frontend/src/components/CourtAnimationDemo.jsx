import { useState, useEffect, useRef } from 'react'

// Court position coordinates (percentage-based for responsiveness)
// Volleyball court positions: I=back-right, II=front-right, III=front-center, IV=front-left, V=back-left, VI=back-center
const POSITIONS = {
  // Front row (top of court view)
  IV: { x: 20, y: 25 },   // Front-left
  III: { x: 50, y: 25 },  // Front-center
  II: { x: 80, y: 25 },   // Front-right
  // Back row (bottom of court view)
  V: { x: 20, y: 75 },    // Back-left
  VI: { x: 50, y: 75 },   // Back-center
  I: { x: 80, y: 75 },    // Back-right
}

// Rotation order: I -> VI -> V -> IV -> III -> II -> I
const ROTATION_ORDER = ['I', 'VI', 'V', 'IV', 'III', 'II']

function getNextPosition(currentPos) {
  const idx = ROTATION_ORDER.indexOf(currentPos)
  return ROTATION_ORDER[(idx + 1) % 6]
}

export default function CourtAnimationDemo() {
  // Initial lineup: position -> player number
  const [lineup, setLineup] = useState({
    I: 1,
    II: 2,
    III: 3,
    IV: 4,
    V: 5,
    VI: 6,
  })

  const [isAnimating, setIsAnimating] = useState(false)
  const [animationPhase, setAnimationPhase] = useState('idle') // 'idle' | 'moving' | 'done'

  // For animation: track where each player is moving FROM
  const [playerPositions, setPlayerPositions] = useState(() => {
    // Initialize: each player at their lineup position
    const positions = {}
    Object.entries(lineup).forEach(([pos, playerNum]) => {
      positions[playerNum] = { ...POSITIONS[pos], position: pos }
    })
    return positions
  })

  const rotate = () => {
    if (isAnimating) return

    setIsAnimating(true)
    setAnimationPhase('moving')

    // Calculate new positions for animation
    const newPlayerPositions = {}
    Object.entries(lineup).forEach(([pos, playerNum]) => {
      const nextPos = getNextPosition(pos)
      newPlayerPositions[playerNum] = { ...POSITIONS[nextPos], position: nextPos }
    })

    // Start animation by updating target positions
    setPlayerPositions(newPlayerPositions)

    // After animation completes, update the actual lineup
    setTimeout(() => {
      const newLineup = {}
      Object.entries(lineup).forEach(([pos, playerNum]) => {
        const nextPos = getNextPosition(pos)
        newLineup[nextPos] = playerNum
      })
      setLineup(newLineup)
      setAnimationPhase('done')
      setIsAnimating(false)
    }, 400) // Match CSS transition duration
  }

  return (
    <div style={{
      padding: 20,
      fontFamily: 'system-ui, sans-serif',
      maxWidth: 500,
      margin: '0 auto'
    }}>
      <h2 style={{ textAlign: 'center', marginBottom: 20 }}>
        Court Rotation Animation Demo
      </h2>

      {/* Court container */}
      <div style={{
        position: 'relative',
        width: '100%',
        paddingBottom: '66%', // 3:2 aspect ratio
        background: 'linear-gradient(to bottom, #4a7c4e 0%, #3d6b40 100%)',
        borderRadius: 8,
        border: '3px solid #fff',
        overflow: 'hidden',
      }}>
        {/* Net line */}
        <div style={{
          position: 'absolute',
          top: '50%',
          left: 0,
          right: 0,
          height: 3,
          background: '#fff',
          transform: 'translateY(-50%)',
        }} />

        {/* Attack lines */}
        <div style={{
          position: 'absolute',
          top: '35%',
          left: 0,
          right: 0,
          height: 2,
          background: 'rgba(255,255,255,0.5)',
        }} />
        <div style={{
          position: 'absolute',
          top: '65%',
          left: 0,
          right: 0,
          height: 2,
          background: 'rgba(255,255,255,0.5)',
        }} />

        {/* Position labels (static) */}
        {Object.entries(POSITIONS).map(([pos, coords]) => (
          <div
            key={`label-${pos}`}
            style={{
              position: 'absolute',
              left: `${coords.x}%`,
              top: `${coords.y}%`,
              transform: 'translate(-50%, -50%)',
              color: 'rgba(255,255,255,0.3)',
              fontSize: 24,
              fontWeight: 'bold',
              pointerEvents: 'none',
              zIndex: 1,
            }}
          >
            {pos}
          </div>
        ))}

        {/* Players (animated) */}
        {Object.entries(playerPositions).map(([playerNum, coords]) => (
          <div
            key={`player-${playerNum}`}
            style={{
              position: 'absolute',
              left: `${coords.x}%`,
              top: `${coords.y}%`,
              transform: 'translate(-50%, -50%)',
              width: 50,
              height: 50,
              borderRadius: '50%',
              background: '#2563eb',
              border: '3px solid #fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontWeight: 'bold',
              fontSize: 20,
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              zIndex: 10,
              // Animation magic happens here!
              transition: 'left 0.4s ease-in-out, top 0.4s ease-in-out',
            }}
          >
            {playerNum}
          </div>
        ))}
      </div>

      {/* Controls */}
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        gap: 10,
        marginTop: 20
      }}>
        <button
          onClick={rotate}
          disabled={isAnimating}
          style={{
            padding: '12px 24px',
            fontSize: 16,
            fontWeight: 'bold',
            background: isAnimating ? '#9ca3af' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            cursor: isAnimating ? 'not-allowed' : 'pointer',
          }}
        >
          {isAnimating ? 'Rotating...' : 'Rotate ↻'}
        </button>
      </div>

      {/* Current lineup display */}
      <div style={{
        marginTop: 20,
        padding: 15,
        background: '#f3f4f6',
        borderRadius: 8,
        fontSize: 14,
      }}>
        <strong>Current Lineup:</strong>
        <div style={{ display: 'flex', gap: 15, marginTop: 8, flexWrap: 'wrap' }}>
          {ROTATION_ORDER.map(pos => (
            <span key={pos}>
              {pos}: #{lineup[pos]}
            </span>
          ))}
        </div>
      </div>

      {/* Explanation */}
      <div style={{
        marginTop: 20,
        padding: 15,
        background: '#fef3c7',
        borderRadius: 8,
        fontSize: 13,
        lineHeight: 1.5,
      }}>
        <strong>How it works:</strong>
        <ul style={{ margin: '8px 0 0 0', paddingLeft: 20 }}>
          <li>Players use <code>position: absolute</code> with percentage coordinates</li>
          <li><code>transition: left 0.4s, top 0.4s</code> handles smooth movement</li>
          <li>Click "Rotate" to see players move clockwise to next position</li>
          <li>Works with any court size (responsive percentages)</li>
        </ul>
      </div>
    </div>
  )
}
