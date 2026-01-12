import React from 'react'
import ReactDOM from 'react-dom'

/**
 * DraggedPlayerOverlay - Floating player number that follows finger/cursor during drag.
 * Renders at document.body level via portal for proper z-index stacking.
 *
 * @param {Object} player - Player info { number, isLibero }
 * @param {Object} position - Screen coordinates { x, y }
 * @param {string} teamColor - Team primary color (e.g., '#ef4444')
 * @param {boolean} isValid - Whether current position is over a valid drop target
 */
export default function DraggedPlayerOverlay({
  player,
  position,
  teamColor = '#64748b',
  isValid = true
}) {
  if (!player || !position) return null

  const bgColor = player.isLibero ? '#FFF8E7' : teamColor
  const textColor = player.isLibero ? '#000' : '#fff'
  const borderColor = player.isLibero
    ? '#3b82f6'
    : isValid
      ? 'rgba(255,255,255,0.5)'
      : 'rgba(239, 68, 68, 0.8)'

  return ReactDOM.createPortal(
    <div
      style={{
        position: 'fixed',
        left: position.x - 28,
        top: position.y - 28,
        width: 56,
        height: 56,
        borderRadius: '50%',
        background: bgColor,
        color: textColor,
        fontSize: 22,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: isValid
          ? '0 8px 24px rgba(0,0,0,0.4)'
          : '0 8px 24px rgba(239, 68, 68, 0.4)',
        border: `3px solid ${borderColor}`,
        pointerEvents: 'none',
        zIndex: 9999,
        transform: 'scale(1.1)',
        transition: 'box-shadow 150ms ease, border-color 150ms ease',
      }}
    >
      {player.number}
      {player.isLibero && (
        <span style={{
          position: 'absolute',
          bottom: -4,
          left: -4,
          width: 18,
          height: 14,
          background: '#3b82f6',
          border: '2px solid rgba(255,255,255,0.6)',
          borderRadius: 3,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 8,
          fontWeight: 700,
          color: '#fff',
        }}>
          L
        </span>
      )}
    </div>,
    document.body
  )
}
