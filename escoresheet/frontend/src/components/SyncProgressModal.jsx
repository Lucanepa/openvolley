import { useEffect, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Circle, Loader2, X } from 'lucide-react'
import { cn, FOCUS_RING } from '../ui'

/**
 * SyncProgressModal - Full-screen overlay showing sync progress steps
 *
 * Props:
 * - open: boolean - whether modal is visible
 * - steps: Array<{ id: string, label: string, status: 'pending'|'in_progress'|'done'|'error'|'warning' }>
 * - errorMessage: string | null - error message to display
 * - onProceed: () => void - callback when user clicks proceed/done
 * - isComplete: boolean - whether all steps are complete
 * - hasError: boolean - whether any step has an error
 * - hasWarning: boolean - whether any step has a warning (offline)
 */
export default function SyncProgressModal({
  open,
  steps = [],
  errorMessage = null,
  onProceed,
  isComplete = false,
  hasError = false,
  hasWarning = false
}) {
  const { t } = useTranslation()
  // Track if we've already triggered auto-proceed to avoid double-calls
  const hasAutoProceeded = useRef(false)

  // Reset tracking when modal opens fresh
  useEffect(() => {
    if (open) {
      hasAutoProceeded.current = false
    }
  }, [open])

  // Auto-proceed after completion (1s for success, 1.5s for warning)
  // Simplified: single effect with all conditions
  useEffect(() => {
    console.log('[SyncModal] Effect check:', { open, isComplete, hasAutoProceeded: hasAutoProceeded.current, hasError, hasWarning })
    if (!open || !isComplete || hasAutoProceeded.current) return

    // Don't auto-proceed on error - user must click button
    if (hasError) return

    const delay = hasWarning ? 1500 : 1000
    console.log('[SyncModal] Starting auto-proceed timer:', delay)

    const timer = setTimeout(() => {
      console.log('[SyncModal] Timer fired, hasAutoProceeded:', hasAutoProceeded.current)
      if (!hasAutoProceeded.current) {
        hasAutoProceeded.current = true
        console.log('[SyncModal] Calling onProceed')
        onProceed?.()
      }
    }, delay)

    return () => {
      console.log('[SyncModal] Cleanup - clearing timer')
      clearTimeout(timer)
    }
  }, [open, isComplete, hasError, hasWarning, onProceed])

  if (!open) return null

  const getStatusIcon = (status) => {
    switch (status) {
      case 'pending':
        return <Circle size={18} className="text-stone-300" aria-hidden="true" />
      case 'in_progress':
        return <Loader2 size={18} className="sync-spinner animate-spin text-stone-500" aria-hidden="true" />
      case 'done':
        return <Check size={18} strokeWidth={2.5} className="text-green-600" aria-hidden="true" />
      case 'warning':
        return <AlertTriangle size={18} className="text-amber-500" aria-hidden="true" />
      case 'error':
        return <X size={18} strokeWidth={2.5} className="text-red-600" aria-hidden="true" />
      default:
        return null
    }
  }

  const getStepLabel = (step) => {
    // Try to get translation, fallback to label
    const translationKey = `scoreboard.sync.${step.label}`
    const translated = t(translationKey)
    return translated !== translationKey ? translated : step.label
  }

  // Opened from the scoreboard: neutral and semantic tones only, no brand fill (R4).
  return (
    <div
      className="ov-kit fixed inset-0 flex items-center justify-center bg-stone-900/60 p-4 backdrop-blur-sm"
      style={{ zIndex: 2000, pointerEvents: 'auto' }}
      onClick={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="sync-progress-title" className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        <h3 id="sync-progress-title" className="mb-3 text-center text-lg font-bold text-stone-900">
          {t('scoreboard.sync.syncing', 'Syncing...')}
        </h3>

        <div className="divide-y divide-stone-100">
          {steps.map((step, index) => (
            <div
              key={step.id || index}
              className={cn('flex min-h-11 items-center gap-3 py-2', step.status === 'pending' && 'opacity-60')}
            >
              <div className="flex w-6 justify-center">
                {getStatusIcon(step.status)}
              </div>
              <span className={cn(
                'text-sm font-medium',
                step.status === 'done' ? 'text-green-700' :
                  step.status === 'error' ? 'text-red-700' :
                    step.status === 'warning' ? 'text-amber-800' : 'text-stone-800'
              )}>
                {getStepLabel(step)}
              </span>
            </div>
          ))}
        </div>

        {/* Warning message for offline */}
        {hasWarning && !hasError && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-center text-sm text-amber-800">
            {t('scoreboard.sync.offlineWarning', 'Offline. Data saved locally.')}
          </div>
        )}

        {/* Error message */}
        {errorMessage && (
          <div role="alert" className="mt-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-center text-sm text-red-700">
            {errorMessage}
          </div>
        )}

        {/* Proceed button - only show if complete with error (user must acknowledge) */}
        {isComplete && hasError && (
          <div className="mt-5 flex justify-center">
            <button
              type="button"
              onClick={onProceed}
              className={cn('inline-flex h-11 w-full items-center justify-center rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white transition-colors hover:bg-slate-800', FOCUS_RING)}
            >
              {t('scoreboard.sync.proceedAnyway', 'Proceed anyway')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
