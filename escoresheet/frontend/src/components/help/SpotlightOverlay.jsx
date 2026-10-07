import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchX } from 'lucide-react'
import { cn } from '../../ui/cn.js'
import { modalPrimaryClass } from '../../ui/Modal.jsx'
import { backdropDismiss } from '../../ui/backdropDismiss.js'

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

  // volleyui: stone-900 scrim, a white ring around the target (no brand red:
  // this can point at scoreboard controls, RESTYLE-SPEC R4), the tip as the
  // dark slate-900 tooltip, and the "not visible" notice as a kit dialog.
  if (notFound) {
    return (
      <div
        {...backdropDismiss(onDismiss)}
        className="no-print fixed inset-0 flex items-center justify-center p-4 bg-stone-900/60 backdrop-blur-sm"
        style={{ zIndex: 1100, animation: 'fade-in 0.2s ease-out' }}
      >
        <div className="ov-kit w-full max-w-sm rounded-xl bg-white p-6 text-center shadow-2xl">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-stone-100 text-stone-400" aria-hidden="true">
            <SearchX size={22} />
          </div>
          <p className="mb-5 text-sm leading-relaxed text-stone-600">
            {t('contextHelp.elementNotVisible', 'This element is not currently visible on the screen. Navigate to the relevant section first.')}
          </p>
          <button
            type="button"
            onClick={onDismiss}
            className={cn(modalPrimaryClass, 'h-11 min-w-24')}
          >
            {t('common.ok', 'OK')}
          </button>
        </div>
      </div>
    )
  }

  if (!rect || !visible) {
    // Loading state - dim screen while searching
    return (
      <div
        className="no-print fixed inset-0 flex items-center justify-center bg-stone-900/50"
        style={{ zIndex: 1100 }}
      >
        <div className="text-sm font-medium text-white/80">
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
        {...backdropDismiss(onDismiss)}
        className="no-print fixed inset-0 cursor-pointer bg-stone-900/70"
        style={{
          zIndex: 1100,
          clipPath,
          animation: 'fade-in 0.2s ease-out'
        }}
      />

      {/* Ring around target */}
      <div
        className="no-print pointer-events-none fixed rounded-xl border-2 border-white"
        style={{
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          zIndex: 1101,
          animation: 'spotlight-pulse 2s infinite'
        }}
      />

      {/* Tooltip */}
      {tooltipPos && (
        <div
          role="tooltip"
          className="no-print fixed rounded-xl bg-slate-900 px-4 py-3.5 text-sm leading-relaxed text-white shadow-card-lg"
          style={{
            top: tooltipPos.above ? undefined : tooltipPos.top,
            bottom: tooltipPos.above ? `${window.innerHeight - rect.top + 12}px` : undefined,
            left: tooltipPos.left,
            width: tooltipPos.width,
            zIndex: 1102,
            animation: 'fade-in 0.3s ease-out'
          }}
        >
          {tooltipKey && t(tooltipKey)}
          <div className="mt-2.5 text-center text-[11px] text-white/60">
            {t('contextHelp.tapToDismiss', 'Tap anywhere to dismiss')}
          </div>
        </div>
      )}

      {/* Inline keyframe for spotlight pulse */}
      <style>{`
        @keyframes spotlight-pulse {
          0%, 100% { box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.25), 0 0 20px rgba(255, 255, 255, 0.15); }
          50% { box-shadow: 0 0 0 6px rgba(255, 255, 255, 0.4), 0 0 30px rgba(255, 255, 255, 0.3); }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes spotlight-pulse {
            0%, 100% { box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.3); }
          }
        }
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </>
  )
}
