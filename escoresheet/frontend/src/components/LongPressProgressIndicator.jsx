import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom'

/**
 * LongPressProgressIndicator - A circular progress ring that appears around the touch point
 * during long-press to indicate drag activation progress.
 *
 * @param {number} progress - Progress value 0-1 (0 = empty, 1 = complete)
 * @param {Object} position - Screen coordinates { x, y } for the center
 * @param {number} size - Diameter in pixels (default: 80)
 * @param {number} strokeWidth - Ring thickness in pixels (default: 4)
 * @param {string} color - Color for the progress ring (default: 'var(--accent)')
 * @param {boolean} visible - Whether to show the indicator
 * @param {number} [duration] - ms: the ring fills by itself in this time (an SVG
 *   animation from the moment it appears); `progress` then only needs to be > 0
 * @param {number} [delay] - ms before the ring shows at all (with `duration`): a
 *   plain tap (shorter) never draws it. It flashed under the finger for a frame
 *   on every tap that opened a player's menu (Point Hub board, 16.11.2026).
 */
export default function LongPressProgressIndicator({
  progress,
  position,
  size = 80,
  strokeWidth = 4,
  color = 'var(--accent)',
  visible = true,
  duration = 0,
  delay = 0
}) {
  const active = !!(visible && progress > 0 && position)
  const [shown, setShown] = useState(!delay)
  useEffect(() => {
    if (!delay) return undefined
    setShown(false)
    if (!active) return undefined
    const timer = setTimeout(() => setShown(true), delay)
    return () => clearTimeout(timer)
  }, [active, delay])
  if (!active || !shown) return null

  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - progress)

  return ReactDOM.createPortal(
    <div
      style={{
        position: 'fixed',
        left: position.x - size / 2,
        top: position.y - size / 2,
        width: size,
        height: size,
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    >
      <svg
        width={size}
        height={size}
        style={{ transform: 'rotate(-90deg)' }}
      >
        {/* Background circle (faded) */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          opacity={0.2}
        />
        {/* Progress circle (fills clockwise from top) */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={duration ? 0 : offset}
          style={duration ? undefined : { transition: 'stroke-dashoffset 16ms linear' }}
        >
          {duration > 0 && (
            <animate
              attributeName="stroke-dashoffset"
              from={circumference * (1 - Math.min(delay, duration) / duration)}
              to="0"
              dur={`${Math.max(1, duration - delay)}ms`}
              fill="freeze"
            />
          )}
        </circle>
      </svg>
    </div>,
    document.body
  )
}
