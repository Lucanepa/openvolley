import { createContext, useContext, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, AlertTriangle, CircleCheck, Info } from 'lucide-react'
import { cn } from '../ui/cn.js'
import { modalPrimaryClass } from '../ui/Modal.jsx'

const AlertContext = createContext(null)

// Kit decision dialog (ConfirmDialog recipe): stone-900/60 scrim with blur,
// white rounded-xl panel, a tinted icon disc that names the kind beside the
// word, body text-sm stone-600, and a neutral slate-900 OK (no brand-red fill:
// alerts also open over the scoreboard, RESTYLE-SPEC R4). Behaviour unchanged:
// the scrim swallows taps, only OK closes, alerts queue one at a time.
const TYPE_TONES = {
  error: { disc: 'bg-red-50 text-red-600', Icon: AlertCircle },
  success: { disc: 'bg-emerald-50 text-emerald-600', Icon: CircleCheck },
  warning: { disc: 'bg-amber-50 text-amber-600', Icon: AlertTriangle },
  info: { disc: 'bg-sky-50 text-sky-600', Icon: Info }
}

function AlertModal({ alert, onClose }) {
  const { t } = useTranslation()

  if (!alert) return null

  const tone = TYPE_TONES[alert.type] || TYPE_TONES.info
  const { Icon } = tone

  return (
    <div
      className="no-print fixed inset-0 flex items-center justify-center p-4 bg-stone-900/60 backdrop-blur-sm"
      style={{ zIndex: 100000 }}
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ov-alert-title"
        aria-describedby="ov-alert-message"
        className="ov-kit w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-3 flex items-center gap-3">
          <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', tone.disc)} aria-hidden="true">
            <Icon size={18} />
          </span>
          <h3 id="ov-alert-title" className="text-lg font-bold capitalize text-stone-900">
            {t(`alert.${alert.type}`, alert.type)}
          </h3>
        </div>

        {/* Body */}
        <div id="ov-alert-message" className="mb-6 text-sm leading-relaxed text-stone-600">
          {alert.message}
        </div>

        {/* Footer */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className={cn(modalPrimaryClass, 'h-11 min-w-24')}
          >
            {t('common.ok', 'OK')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function AlertProvider({ children }) {
  const [alerts, setAlerts] = useState([])

  const showAlert = useCallback((message, type = 'info') => {
    const id = Date.now() + Math.random()
    setAlerts(prev => [...prev, { id, message, type }])
  }, [])

  const closeAlert = useCallback((id) => {
    setAlerts(prev => prev.filter(a => a.id !== id))
  }, [])

  // Show only the first alert (queue behavior)
  const currentAlert = alerts[0] || null

  const value = useMemo(() => ({ showAlert }), [showAlert])

  return (
    <AlertContext.Provider value={value}>
      {children}
      <AlertModal
        alert={currentAlert}
        onClose={() => currentAlert && closeAlert(currentAlert.id)}
      />
    </AlertContext.Provider>
  )
}

export function useAlert() {
  const context = useContext(AlertContext)
  if (!context) {
    throw new Error('useAlert must be used within an AlertProvider')
  }
  return context
}
