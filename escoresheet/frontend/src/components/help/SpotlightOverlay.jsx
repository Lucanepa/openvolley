import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

export default function SpotlightOverlay({ targetHelpId, tooltipKey, onDismiss }) {
  const { t } = useTranslation()
  const [rect, setRect] = useState(null)
  const [tooltipPos, setTooltipPos] = useState(null)
  const [visible, setVisible] = useState(false)
  const [notFound, setNotFound] = useState(false)

  const PAD = 8

  const findAndHighlight = useCallback(() => {
    const el = document.querySelector(`[data-help-id="${targetHelpId}"]`)
    if (!el) {
      setNotFound(true)
      return
    }

    // Scroll into view first
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })

    // Wait for scroll to settle, then measure
    setTimeout(() => {
      const elRect = el.getBoundingClientRect()
      if (elRect.width === 0 && elRect.height === 0) {
        setNotFound(true)
        return
      }

      setRect({
        top: elRect.top - PAD,
        left: elRect.left - PAD,
        right: elRect.right + PAD,
        bottom: elRect.bottom + PAD,
        width: elRect.width + PAD * 2,
        height: elRect.height + PAD * 2
      })

      // Position tooltip
      const vw = window.innerWidth
      const vh = window.innerHeight
      const tooltipW = Math.min(300, vw - 40)
      const spaceBelow = vh - elRect.bottom - PAD
      const spaceAbove = elRect.top - PAD

      let top, left
      if (spaceBelow > 120) {
        top = elRect.bottom + PAD + 12
      } else if (spaceAbove > 120) {
        top = elRect.top - PAD - 12 // Will be adjusted after render
      } else {
        top = Math.max(20, elRect.top)
      }

      left = elRect.left + elRect.width / 2 - tooltipW / 2
      left = Math.max(20, Math.min(left, vw - tooltipW - 20))

      setTooltipPos({ top, left, width: tooltipW, above: spaceBelow <= 120 && spaceAbove > 120 })
      setVisible(true)
    }, 350)
  }, [targetHelpId])

  useEffect(() => {
    findAndHighlight()
  }, [findAndHighlight])

  // ESC to dismiss
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onDismiss()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onDismiss])

  // Window resize -> dismiss
  useEffect(() => {
    const handleResize = () => onDismiss()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [onDismiss])

  if (notFound) {
    return (
      <div
        onClick={onDismiss}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1100,
          background: 'rgba(0,0,0,0.8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          animation: 'fade-in 0.2s ease-out'
        }}
      >
        <div style={{
          background: '#1f2937',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 12,
          padding: '20px 28px',
          maxWidth: 340,
          textAlign: 'center',
          color: 'rgba(255,255,255,0.8)',
          fontSize: 14,
          lineHeight: 1.6
        }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>&#x1F50D;</div>
          {t('contextHelp.elementNotVisible', 'This element is not currently visible on the screen. Navigate to the relevant section first.')}
          <div style={{ marginTop: 12 }}>
            <button
              onClick={onDismiss}
              style={{
                padding: '8px 20px',
                background: 'rgba(59, 130, 246, 0.3)',
                border: '1px solid rgba(59, 130, 246, 0.5)',
                borderRadius: 6,
                color: '#60a5fa',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              {t('common.ok', 'OK')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!rect || !visible) {
    // Loading state - dim screen while searching
    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14 }}>
          {t('common.loading', 'Loading...')}
        </div>
      </div>
    )
  }

  // Build clip-path polygon with cutout
  const clipPath = `polygon(
    evenodd,
    0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
    ${rect.left}px ${rect.top}px,
    ${rect.right}px ${rect.top}px,
    ${rect.right}px ${rect.bottom}px,
    ${rect.left}px ${rect.bottom}px,
    ${rect.left}px ${rect.top}px
  )`

  return (
    <>
      {/* Dark overlay with cutout */}
      <div
        onClick={onDismiss}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1100,
          background: 'rgba(0,0,0,0.75)',
          clipPath,
          animation: 'fade-in 0.2s ease-out',
          cursor: 'pointer'
        }}
      />

      {/* Glowing border around target */}
      <div
        style={{
          position: 'fixed',
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          zIndex: 1101,
          borderRadius: 8,
          border: '2px solid rgba(59, 130, 246, 0.7)',
          boxShadow: '0 0 0 4px rgba(59, 130, 246, 0.3), 0 0 20px rgba(59, 130, 246, 0.2)',
          pointerEvents: 'none',
          animation: 'spotlight-pulse 2s infinite'
        }}
      />

      {/* Tooltip */}
      {tooltipPos && (
        <div
          style={{
            position: 'fixed',
            top: tooltipPos.above ? undefined : tooltipPos.top,
            bottom: tooltipPos.above ? `${window.innerHeight - rect.top + 12}px` : undefined,
            left: tooltipPos.left,
            width: tooltipPos.width,
            zIndex: 1102,
            background: '#1f2937',
            border: '1px solid rgba(59, 130, 246, 0.4)',
            borderRadius: 10,
            padding: '14px 18px',
            color: 'rgba(255,255,255,0.9)',
            fontSize: 13,
            lineHeight: 1.6,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            animation: 'fade-in 0.3s ease-out'
          }}
        >
          {tooltipKey && t(tooltipKey)}
          <div style={{
            marginTop: 10,
            fontSize: 11,
            opacity: 0.5,
            textAlign: 'center'
          }}>
            {t('contextHelp.tapToDismiss', 'Tap anywhere to dismiss')}
          </div>
        </div>
      )}

      {/* Inline keyframe for spotlight pulse */}
      <style>{`
        @keyframes spotlight-pulse {
          0%, 100% { box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.3), 0 0 20px rgba(59, 130, 246, 0.2); }
          50% { box-shadow: 0 0 0 6px rgba(59, 130, 246, 0.5), 0 0 30px rgba(59, 130, 246, 0.4); }
        }
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </>
  )
}
