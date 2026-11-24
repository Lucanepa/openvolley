import React from 'react'

/**
 * DonutCountdown - A circular progress ring that depletes counterclockwise
 *
 * @param {number} current - Current seconds remaining
 * @param {number} total - Total seconds (e.g., 30 for TO, 180 for interval)
 * @param {number} size - Diameter in pixels (default: 120)
 * @param {number} strokeWidth - Ring thickness in pixels (default: 8)
 * @param {React.ReactNode} children - Content to display in center (countdown text)
 */
export default function DonutCountdown({
  current,
  total,
  size = 120,
  strokeWidth = 8,
  children
}) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const progress = Math.max(0, Math.min(1, current / total))
  const offset = circumference * (1 - progress)

  return (
    <div style={{
      position: 'relative',
      width: size,
      height: size,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }}>
      {/* SVG Ring */}
      <svg
        width={size}
        height={size}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          transform: 'rotate(-90deg)', // Start from top
        }}
      >
        {/* Background circle (faded) */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={strokeWidth}
          opacity={0.2}
        />
        {/* Progress circle (depletes counterclockwise) */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{
            transition: 'stroke-dashoffset 1s linear'
          }}
        />
      </svg>

      {/* Center content (countdown text) */}
      <div style={{
        position: 'relative',
        zIndex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        {children}
      </div>
    </div>
  )
}
