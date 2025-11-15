export default function Modal({ title, open, onClose, children, width = 800, hideCloseButton = false, position = 'center' }) {
  if (!open) return null
  const widthStyle = width === 'auto' ? 'auto' : `min(95vw,${width}px)`
  
  // For custom positioning, the parent div will handle it
  if (position === 'custom') {
    return (
      <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.6)', zIndex:1000, pointerEvents:'none' }}>
        <div style={{ width: widthStyle, maxHeight:'90vh', overflow:'auto', background:'#111827', border:'1px solid rgba(255,255,255,.08)', borderRadius:12, padding:16, pointerEvents: 'auto' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
            <h3 style={{ margin:0 }}>{title}</h3>
            {!hideCloseButton && <button className="secondary" onClick={onClose}>Close</button>}
          </div>
          {children}
        </div>
      </div>
    )
  }
  
  // Regular positioning
  const overlayStyle = position === 'left' || position === 'right'
    ? { position:'fixed', inset:0, background:'rgba(0,0,0,.6)', display:'flex', alignItems:'center', justifyContent: position === 'left' ? 'flex-start' : 'flex-end', zIndex:1000, padding: '0 20px' }
    : { position:'fixed', inset:0, background:'rgba(0,0,0,.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }
  
  return (
    <div style={overlayStyle}>
      <div style={{ width: widthStyle, maxHeight:'90vh', overflow:'auto', background:'#111827', border:'1px solid rgba(255,255,255,.08)', borderRadius:12, padding:16 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
          <h3 style={{ margin:0 }}>{title}</h3>
          {!hideCloseButton && <button className="secondary" onClick={onClose}>Close</button>}
        </div>
        {children}
      </div>
    </div>
  )
}

