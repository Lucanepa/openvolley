import { useRef, useEffect, useState } from 'react'
import Modal from './Modal'

export default function SignaturePad({ open, onClose, onSave, title = 'Sign' }) {
  const canvasRef = useRef(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [hasSignature, setHasSignature] = useState(false)

  useEffect(() => {
    if (!open) {
      setHasSignature(false)
      return
    }
    // Wait for modal to render before sizing canvas
    const timer = setTimeout(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      
      // Set canvas size based on container
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      
      // Scale context to match device pixel ratio
      ctx.scale(dpr, dpr)
      
      // Set drawing style
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      
      // Clear canvas
      ctx.clearRect(0, 0, rect.width, rect.height)
      setHasSignature(false)
    }, 100)
    
    return () => clearTimeout(timer)
  }, [open])

  function getPoint(e) {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    if (e.touches && e.touches.length > 0) {
      return {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top
      }
    }
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    }
  }

  function startDrawing(e) {
    e.preventDefault()
    setIsDrawing(true)
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const point = getPoint(e)
    ctx.beginPath()
    ctx.moveTo(point.x, point.y)
  }

  function draw(e) {
    if (!isDrawing) return
    e.preventDefault()
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const point = getPoint(e)
    ctx.lineTo(point.x, point.y)
    ctx.stroke()
    setHasSignature(true)
  }

  function stopDrawing(e) {
    e.preventDefault()
    setIsDrawing(false)
  }

  function clear() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const rect = canvas.getBoundingClientRect()
    ctx.clearRect(0, 0, rect.width, rect.height)
    setHasSignature(false)
  }

  function save() {
    const canvas = canvasRef.current
    if (!canvas || !hasSignature) return
    const dataURL = canvas.toDataURL('image/png')
    onSave(dataURL)
    onClose()
  }

  return (
    <Modal title={title} open={open} onClose={onClose} width={600}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ 
          border: '2px solid rgba(255,255,255,.2)', 
          borderRadius: 8, 
          background: '#0b1220',
          position: 'relative',
          touchAction: 'none'
        }}>
          <canvas
            ref={canvasRef}
            style={{ 
              width: '100%', 
              height: '200px', 
              display: 'block',
              cursor: 'crosshair'
            }}
            onMouseDown={startDrawing}
            onMouseMove={draw}
            onMouseUp={stopDrawing}
            onMouseLeave={stopDrawing}
            onTouchStart={startDrawing}
            onTouchMove={draw}
            onTouchEnd={stopDrawing}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="secondary" onClick={clear}>Clear</button>
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button onClick={save} disabled={!hasSignature}>Save</button>
        </div>
      </div>
    </Modal>
  )
}

