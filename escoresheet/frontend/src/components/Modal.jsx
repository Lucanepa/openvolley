import { useTranslation } from 'react-i18next'

export default function Modal({ title, open, onClose, children, width = 800, hideCloseButton = false, position = 'center', customStyle = {}, zIndex = 1000 }) {
  const { t } = useTranslation()

  if (!open) return null

  // Modal dimensions should NOT be scaled - scaling is for scoreboard content, not UI chrome
  const modalWidth = width === 'auto' ? 'auto' : `min(95vw,${width}px)`
  const padding = 16
  const borderRadius = 12
  const marginBottom = 8

  // Stop all clicks/touches on backdrop to prevent interaction with elements behind modal
  const handleBackdropClick = (e) => {
    e.stopPropagation()
    e.preventDefault()
  }

  // For custom positioning, the parent div will handle it
  if (position === 'custom') {
    return (
      <div
        style={{ position:'fixed', inset:0, background:'rgba(15, 23, 42, 0.5)', zIndex, pointerEvents:'auto' }}
        onClick={handleBackdropClick}
        onTouchStart={handleBackdropClick}
      >
        <div
          style={{
            width: modalWidth,
            maxHeight:'90vh',
            overflow:'auto',
            background:'var(--panel)',
            border:'1px solid var(--border)',
            borderRadius: borderRadius,
            padding: padding,
            ...customStyle
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {(title || !hideCloseButton) && (
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: marginBottom }}>
              <h3 style={{ margin:0 }}>{title}</h3>
              {!hideCloseButton && <button className="secondary" onClick={onClose}>{t('modal.close', 'Close')}</button>}
            </div>
          )}
          {children}
        </div>
      </div>
    )
  }

  // Regular positioning
  const overlayStyle = position === 'left' || position === 'right'
    ? { position:'fixed', inset:0, background:'rgba(15, 23, 42, 0.5)', display:'flex', alignItems:'center', justifyContent: position === 'left' ? 'flex-start' : 'flex-end', zIndex, padding: '0 20px' }
    : { position:'fixed', inset:0, background:'rgba(15, 23, 42, 0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex }

  return (
    <div
      style={overlayStyle}
      onClick={handleBackdropClick}
      onTouchStart={handleBackdropClick}
    >
      <div
        style={{ width: modalWidth, maxHeight:'90vh', overflow:'auto', background:'var(--panel)', border:'1px solid var(--border)', borderRadius: borderRadius, padding: padding }}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || !hideCloseButton) && (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: marginBottom }}>
            <h3 style={{ margin:0 }}>{title}</h3>
            {!hideCloseButton && <button className="secondary" onClick={onClose}>{t('modal.close', 'Close')}</button>}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
