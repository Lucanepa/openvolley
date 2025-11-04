export default function Modal({ title, open, onClose, children, width = 800 }) {
  if (!open) return null
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
      <div style={{ width: 'min(95vw,'+width+'px)', maxHeight:'90vh', overflow:'auto', background:'#111827', border:'1px solid rgba(255,255,255,.08)', borderRadius:12, padding:16 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
          <h3 style={{ margin:0 }}>{title}</h3>
          <button className="secondary" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  )
}


