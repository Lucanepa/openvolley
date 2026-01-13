import { useTranslation } from 'react-i18next'

export default function Modal({ title, open, onClose, children, width = 800, hideCloseButton = false, position = 'center', customStyle = {}, zIndex = 1000 }) {
  const { t } = useTranslation()
  if (!open) return null
  const widthStyle = width === 'auto' ? 'auto' : `min(95vw,${width}px)`

  // Stop all clicks/touches on backdrop to prevent interaction with elements behind modal
  const handleBackdropClick = (e) => {
    e.stopPropagation()
    e.preventDefault()
  }

  // For custom positioning, the parent div will handle it
  if (position === 'custom') {
    return (
      <div
        style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.8)', zIndex, pointerEvents:'auto' }}
        onClick={handleBackdropClick}
        onTouchStart={handleBackdropClick}
      >
        <div
          style={{
            width: widthStyle,
            maxHeight:'90vh',
            overflow:'auto',
            background:'#111827',
            border:'1px solid rgba(255,255,255,.08)',
            borderRadius:12,
            padding:16,
            ...customStyle
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {(title || !hideCloseButton) && (
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
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
    ? { position:'fixed', inset:0, background:'rgba(0,0,0,.8)', display:'flex', alignItems:'center', justifyContent: position === 'left' ? 'flex-start' : 'flex-end', zIndex, padding: '0 20px' }
    : { position:'fixed', inset:0, background:'rgba(0,0,0,.8)', display:'flex', alignItems:'center', justifyContent:'center', zIndex }

  return (
    <div
      style={overlayStyle}
      onClick={handleBackdropClick}
      onTouchStart={handleBackdropClick}
    >
      <div
        style={{ width: widthStyle, maxHeight:'90vh', overflow:'auto', background:'#111827', border:'1px solid rgba(255,255,255,.08)', borderRadius:12, padding:16 }}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || !hideCloseButton) && (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
            <h3 style={{ margin:0 }}>{title}</h3>
            {!hideCloseButton && <button className="secondary" onClick={onClose}>{t('modal.close', 'Close')}</button>}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
