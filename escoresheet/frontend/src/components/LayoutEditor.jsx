import { useEffect, useState } from 'react'
import { applyLayout, loadLayout, saveLayout, defaultLayout } from '../lib/layout'

export default function LayoutEditor({ open, onClose }) {
  const [cfg, setCfg] = useState(() => loadLayout() || defaultLayout())

  useEffect(() => { if (open) applyLayout(cfg) }, [open])

  function update(key, value) {
    const next = { ...cfg, [key]: value }
    setCfg(next)
    applyLayout(next)
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'layout.json'; a.click(); URL.revokeObjectURL(url)
  }

  if (!open) return null
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1100 }}>
      <div style={{ width:'min(96vw,900px)', maxHeight:'90vh', overflow:'auto', background:'#111827', border:'1px solid rgba(255,255,255,.08)', borderRadius:12, padding:16 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <h3 style={{ margin:0 }}>Layout editor</h3>
          <div style={{ display:'flex', gap:8 }}>
            <button className="secondary" onClick={() => { saveLayout(cfg); onClose() }}>Save</button>
            <button className="secondary" onClick={exportJson}>Export JSON</button>
            <button className="secondary" onClick={onClose}>Close</button>
          </div>
        </div>

        <section style={{ marginTop:12 }}>
          <h4>Match info columns</h4>
          {['info-c1','info-c2','info-c3','info-c4'].map(k => (
            <div key={k} style={{ display:'flex', alignItems:'center', gap:8, margin:'6px 0' }}>
              <label style={{ width:120 }}>{k}</label>
              <input type="range" min="10" max="40" value={parseInt((cfg[k]||'22%'))} onChange={e=>update(k, e.target.value+'%')} />
              <input className="w-120" value={cfg[k]} onChange={e=>update(k, e.target.value)} />
            </div>
          ))}
        </section>

        <section style={{ marginTop:12 }}>
          <h4>Officials columns</h4>
          {['off-c1','off-c2','off-c3','off-c4','off-c5'].map(k => (
            <div key={k} style={{ display:'flex', alignItems:'center', gap:8, margin:'6px 0' }}>
              <label style={{ width:120 }}>{k}</label>
              <input type="range" min="10" max="40" value={parseInt((cfg[k]||'15%'))} onChange={e=>update(k, e.target.value+'%')} />
              <input className="w-120" value={cfg[k]} onChange={e=>update(k, e.target.value)} />
            </div>
          ))}
        </section>

        <section style={{ marginTop:12 }}>
          <h4>Roster widths</h4>
          {['w-num','w-name','w-dob'].map(k => (
            <div key={k} style={{ display:'flex', alignItems:'center', gap:8, margin:'6px 0' }}>
              <label style={{ width:120 }}>{k}</label>
              <input type="range" min="50" max="320" value={parseInt((cfg[k]||'100px'))} onChange={e=>update(k, e.target.value+'px')} />
              <input className="w-120" value={cfg[k]} onChange={e=>update(k, e.target.value)} />
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}



