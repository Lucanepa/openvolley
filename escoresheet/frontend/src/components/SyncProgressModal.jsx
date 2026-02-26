import { useEffect, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'

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
        return (
          <span style={{ color: '#6b7280', fontSize: 20 }}>○</span>
        )
      case 'in_progress':
        return (
          <span
            className="sync-spinner"
            style={{
              display: 'inline-block',
              width: 20,
              height: 20,
              border: '2px solid #3b82f6',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite'
            }}
          />
        )
      case 'done':
        return (
          <span style={{ color: '#22c55e', fontSize: 20 }}>✓</span>
        )
      case 'warning':
        return (
          <span style={{ color: '#f59e0b', fontSize: 20 }}>⚠</span>
        )
      case 'error':
        return (
          <span style={{ color: '#ef4444', fontSize: 20 }}>✗</span>
        )
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

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.9)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
        pointerEvents: 'auto'
      }}
      onClick={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <style>
        {`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}
      </style>

      <div
        style={{
          background: '#111827',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 16,
          padding: 32,
          minWidth: 320,
          maxWidth: '90vw'
        }}
      >
        <h3 style={{
          margin: '0 0 24px 0',
          textAlign: 'center',
          color: '#fff',
          fontSize: 18
        }}>
          {t('scoreboard.sync.syncing', 'Syncing...')}
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {steps.map((step, index) => (
            <div
              key={step.id || index}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                opacity: step.status === 'pending' ? 0.5 : 1
              }}
            >
              <div style={{ width: 24, display: 'flex', justifyContent: 'center' }}>
                {getStatusIcon(step.status)}
              </div>
              <span style={{
                color: step.status === 'done' ? '#22c55e' :
                  step.status === 'error' ? '#ef4444' :
                    step.status === 'warning' ? '#f59e0b' : '#fff',
                fontSize: 16
              }}>
                {getStepLabel(step)}
              </span>
            </div>
          ))}
        </div>

        {/* Warning message for offline */}
        {hasWarning && !hasError && (
          <div style={{
            marginTop: 20,
            padding: 12,
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            borderRadius: 8,
            color: '#f59e0b',
            fontSize: 14,
            textAlign: 'center'
          }}>
            {t('scoreboard.sync.offlineWarning', 'Offline. Data saved locally.')}
          </div>
        )}

        {/* Error message */}
        {errorMessage && (
          <div style={{
            marginTop: 20,
            padding: 12,
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: 8,
            color: '#ef4444',
            fontSize: 14,
            textAlign: 'center'
          }}>
            {errorMessage}
          </div>
        )}

        {/* Proceed button - only show if complete with error (user must acknowledge) */}
        {isComplete && hasError && (
          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center' }}>
            <button
              onClick={onProceed}
              style={{
                padding: '12px 24px',
                background: '#f59e0b',
                color: '#000',
                border: 'none',
                borderRadius: 8,
                fontSize: 16,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              {t('scoreboard.sync.proceedAnyway', 'Proceed Anyway')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
