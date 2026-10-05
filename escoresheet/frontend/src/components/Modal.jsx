import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { IconButton } from '../ui/IconButton.jsx'

// The app's legacy modal shell, on the volleyui recipe (kit Modal, plain layout):
// stone-900/50 scrim with blur, white rounded-2xl panel with shadow-2xl, a
// text-lg title and the round × close button. The API and behaviour are
// unchanged on purpose: the backdrop swallows taps and never closes the modal
// (scoring screens depend on that), there is no Escape handling, and
// `width`, `position`, `customStyle` and `zIndex` work as before.
//
// Children are NOT wrapped in `.ov-kit`: they are legacy views (lineup grid,
// set-end readouts...) that rely on the legacy element rules. Only the close
// button sits in its own `.ov-kit` box, so the legacy `button` rule (scoring
// green) cannot reach it.
const OVERLAY = 'no-print fixed inset-0 bg-stone-900/50 backdrop-blur-sm'
const PANEL = 'bg-white rounded-2xl shadow-2xl p-5 max-h-[85vh] overflow-auto text-stone-800'

export default function Modal({ title, open, onClose, children, width = 800, hideCloseButton = false, position = 'center', customStyle = {}, zIndex = 1000 }) {
  const { t } = useTranslation()

  if (!open) return null

  // Modal dimensions should NOT be scaled - scaling is for scoreboard content, not UI chrome
  const modalWidth = width === 'auto' ? 'auto' : `min(95vw,${width}px)`

  // Stop all clicks/touches on backdrop to prevent interaction with elements behind modal
  const handleBackdropClick = (e) => {
    e.stopPropagation()
    e.preventDefault()
  }

  const closeLabel = t('modal.close', 'Close')
  const header = (title || !hideCloseButton) && (
    <div className="flex items-start justify-between gap-3 mb-3">
      <h3 className="m-0 min-w-0 pt-1.5 text-lg font-bold leading-snug text-stone-900">{title}</h3>
      {!hideCloseButton && (
        <span className="ov-kit -mr-2 -mt-1 shrink-0">
          <IconButton variant="close" label={closeLabel} icon={X} onClick={onClose} />
        </span>
      )}
    </div>
  )

  // For custom positioning, the parent div will handle it
  if (position === 'custom') {
    return (
      <div
        className={OVERLAY}
        style={{ zIndex, pointerEvents: 'auto' }}
        onClick={handleBackdropClick}
        onTouchStart={handleBackdropClick}
      >
        <div
          role="dialog"
          aria-modal="true"
          className={PANEL}
          style={{ width: modalWidth, ...customStyle }}
          onClick={(e) => e.stopPropagation()}
        >
          {header}
          {children}
        </div>
      </div>
    )
  }

  // Regular positioning
  const overlayClass = position === 'left' || position === 'right'
    ? `${OVERLAY} flex items-center px-5 ${position === 'left' ? 'justify-start' : 'justify-end'}`
    : `${OVERLAY} flex items-center justify-center`

  return (
    <div
      className={overlayClass}
      style={{ zIndex }}
      onClick={handleBackdropClick}
      onTouchStart={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={PANEL}
        style={{ width: modalWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        {header}
        {children}
      </div>
    </div>
  )
}
