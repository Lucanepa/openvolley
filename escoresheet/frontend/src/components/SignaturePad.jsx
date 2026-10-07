import { useRef, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Smartphone } from 'lucide-react'
import Modal from './Modal'
import { Button } from '../ui/Button.jsx'
import PhoneSignPanel, { usePhoneSignTransports } from './signature/PhoneSignPanel'
import { REASON_KEYS } from '../utils/phoneSignTransport'

/**
 * The signature modal of every slot: draw on this device, or (with `phone`)
 * "Sign on phone" (docs/qr-signing-spec.md 5.3): a QR code the signer opens on
 * their own phone; the strokes come back and become the same kind of image.
 *
 * onSave(dataUrl, meta): meta = { source: 'device' } or
 * { source: 'phone', transport: 'cloud' | 'lan' }.
 *
 * @param {{ open: boolean, onClose: () => void, onSave: (dataUrl: string, meta: object) => void,
 *   title?: string, existingSignature?: string|null, readOnly?: boolean, zIndex?: number,
 *   phone?: { slot: string, matchKey?: string|null, context: object, gamePin?: string|null,
 *     onOpenConnectTablets?: () => void } | null }} props
 */
export default function SignaturePad({ open, onClose, onSave, title = 'Sign', existingSignature = null, readOnly = false, zIndex, phone = null }) {
  const { t } = useTranslation()
  const canvasRef = useRef(null)
  const isDrawingRef = useRef(false)
  const [isDrawing, setIsDrawing] = useState(false)
  const [hasSignature, setHasSignature] = useState(false)
  const [mode, setMode] = useState('draw') // 'draw' | 'phone'
  const [hallIp, setHallIp] = useState(null)
  const phoneOffered = !!phone && !readOnly
  const { transports } = usePhoneSignTransports(open && phoneOffered, { hallIp })

  // Every opening starts on the pad
  useEffect(() => {
    if (!open) setMode('draw')
  }, [open])

  useEffect(() => {
    if (!open || mode !== 'draw') {
      setHasSignature(false)
      return
    }
    
    let cleanup = null
    let timerId = null
    
    // Wait for modal to render before sizing canvas
    timerId = setTimeout(() => {
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
      ctx.strokeStyle = '#000000' // Black strokes
      ctx.lineWidth = 4 // Thicker lines for better visibility in PDF
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      
      // Load existing signature if provided, otherwise clear canvas
      if (existingSignature) {
        const img = new Image()
        img.onload = () => {
          // Draw the existing signature to fill the canvas
          // Note: ctx is already scaled by dpr, so we draw at the display size
          ctx.drawImage(img, 0, 0, rect.width, rect.height)
          setHasSignature(true)
        }
        img.onerror = () => {
          // If image fails to load, clear canvas
          ctx.clearRect(0, 0, rect.width, rect.height)
          setHasSignature(false)
        }
        img.src = existingSignature
      } else {
        // Clear canvas (transparent background)
        ctx.clearRect(0, 0, rect.width, rect.height)
        setHasSignature(false)
      }
      
      // Add touch event listeners with passive: false to allow preventDefault
      const getPointForTouch = (e) => {
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
      
      const touchStartHandler = (e) => {
        e.preventDefault()
        isDrawingRef.current = true
        setIsDrawing(true)
        const point = getPointForTouch(e)
        ctx.beginPath()
        ctx.moveTo(point.x, point.y)
      }
      const touchMoveHandler = (e) => {
        if (!isDrawingRef.current) return
        e.preventDefault()
        const point = getPointForTouch(e)
        ctx.lineTo(point.x, point.y)
        ctx.stroke()
        setHasSignature(true)
      }
      const touchEndHandler = (e) => {
        e.preventDefault()
        isDrawingRef.current = false
        setIsDrawing(false)
      }
      
      // Only add drawing event listeners if not read-only
      if (!readOnly) {
        canvas.addEventListener('touchstart', touchStartHandler, { passive: false })
        canvas.addEventListener('touchmove', touchMoveHandler, { passive: false })
        canvas.addEventListener('touchend', touchEndHandler, { passive: false })

        cleanup = () => {
          canvas.removeEventListener('touchstart', touchStartHandler)
          canvas.removeEventListener('touchmove', touchMoveHandler)
          canvas.removeEventListener('touchend', touchEndHandler)
        }
      }
    }, 100)
    
    return () => {
      if (timerId) clearTimeout(timerId)
      if (cleanup) cleanup()
    }
  }, [open, existingSignature, readOnly, mode])

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
    isDrawingRef.current = true
    setIsDrawing(true)
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const point = getPoint(e)
    ctx.beginPath()
    ctx.moveTo(point.x, point.y)
  }

  function draw(e) {
    if (!isDrawingRef.current) return
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
    isDrawingRef.current = false
    setIsDrawing(false)
  }

  function clear() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const rect = canvas.getBoundingClientRect()
    // Clear canvas (transparent)
    ctx.clearRect(0, 0, rect.width, rect.height)
    setHasSignature(false)
  }

  function save() {
    const canvas = canvasRef.current
    if (!canvas || !hasSignature) return
    const dataURL = canvas.toDataURL('image/png')
    onSave(dataURL, { source: 'device' })
    onClose()
  }

  function acceptPhoneSignature(dataUrl, meta) {
    onSave(dataUrl, meta)
    onClose()
  }

  function handleCancel() {
    // Just close without saving - don't clear existing signature
    onClose()
  }

  const phoneReason = phoneOffered && !transports.default ? t(REASON_KEYS[transports.reason] || REASON_KEYS.none) : null

  return (
    <Modal title={title} open={open} onClose={onClose} width={mode === 'phone' ? 640 : 600} zIndex={zIndex}>
      {/* `phone` can go away while the modal is open (the caller's data
          reloading): back on the pad rather than reading a null */}
      {mode === 'phone' && phoneOffered ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <PhoneSignPanel
            transports={transports}
            slot={phone.slot}
            matchKey={phone.matchKey || null}
            context={phone.context}
            gamePin={phone.gamePin || null}
            onUse={acceptPhoneSignature}
            onHallIp={setHallIp}
            onOpenConnectTablets={phone.onOpenConnectTablets}
          />
          <div className="ov-kit flex flex-wrap items-center gap-2 border-t border-stone-200 pt-3">
            <Button variant="ghost" size="xl" className="font-medium" onClick={() => setMode('draw')} data-testid="sign-here-instead">{t('phoneSign.signHereInstead')}</Button>
            <Button variant="secondary" size="xl" className="ml-auto font-medium" onClick={handleCancel}>{t('signature.cancel', 'Cancel')}</Button>
          </div>
        </div>
      ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Drawing surface: white (the saved PNG is transparent and lands on
            the white paper sheet), a stone-300 hairline, one radius step
            inside the dialog. */}
        <div
          className="relative overflow-hidden rounded-xl border border-stone-300 bg-white"
          style={{ touchAction: 'none' }}
        >
          <canvas
            ref={canvasRef}
            style={{
              width: '100%',
              height: '200px',
              display: 'block',
              cursor: readOnly ? 'default' : 'crosshair',
              background: '#ffffff'
            }}
            onMouseDown={readOnly ? undefined : startDrawing}
            onMouseMove={readOnly ? undefined : draw}
            onMouseUp={readOnly ? undefined : stopDrawing}
            onMouseLeave={readOnly ? undefined : stopDrawing}
          />
        </div>
        {/* Footer: Clear is a quiet tool on the left; Cancel then the commit
            on the right (emerald = saving). h-11: signed courtside. */}
        <div className="ov-kit flex flex-wrap items-center gap-2">
          {readOnly ? (
            <Button variant="dark" size="xl" className="ml-auto" onClick={onClose}>{t('signature.close', 'Close')}</Button>
          ) : (
            <>
              {phoneOffered && (
                <Button
                  variant="secondary"
                  size="xl"
                  icon={Smartphone}
                  className="font-medium"
                  onClick={() => setMode('phone')}
                  disabled={!transports.default}
                  title={phoneReason || undefined}
                  data-testid="sign-on-phone"
                >
                  {t('phoneSign.signOnPhone')}
                </Button>
              )}
              <Button variant="ghost" size="xl" className="font-medium" onClick={clear}>{t('signature.clear', 'Clear')}</Button>
              <Button variant="secondary" size="xl" className="ml-auto font-medium" onClick={handleCancel}>{t('signature.cancel', 'Cancel')}</Button>
              <Button variant="positive" size="xl" onClick={save} disabled={!hasSignature}>{t('signature.save', 'Save')}</Button>
            </>
          )}
        </div>
        {phoneReason && (
          <p className="text-xs leading-snug text-stone-500" data-testid="sign-on-phone-reason">{phoneReason}</p>
        )}
      </div>
      )}
    </Modal>
  )
}

