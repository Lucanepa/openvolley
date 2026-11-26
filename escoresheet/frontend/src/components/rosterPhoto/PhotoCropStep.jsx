import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The photo with the page's four corners to drag (utils/rosterPhoto/scan.js
 * guessCorners gives the first guess). corners: [tl, tr, br, bl] in the
 * photo's pixels; the edge tl → tr is the page's top, drawn thicker with a
 * mark (Turn moves it to the next side). Pointer events: a finger, a pen or
 * a mouse; touch-action none on the drawing so dragging never scrolls.
 */
export default function PhotoCropStep ({ url, width, height, corners, onChange }) {
  const { t } = useTranslation()
  const boxRef = useRef(null)
  const svgRef = useRef(null)
  const [scale, setScale] = useState(0)
  const drag = useRef(null)

  // the photo as large as the dialog allows, never wider than its box or
  // taller than 55 % of the screen; measured before the first paint
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return undefined
    const fit = () => {
      const maxH = Math.max(240, (window.innerHeight || 800) * 0.55)
      // (a box not laid out yet measures 0: the screen's width then, never a blank photo)
      // (less the room round the photo: px-4 on each side)
      const maxW = Math.max(1, (box.clientWidth || Math.min(window.innerWidth || width, width)) - 32)
      setScale(Math.min(maxW / width, maxH / height))
    }
    fit()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
    ro?.observe(box)
    window.addEventListener('resize', fit)
    return () => { ro?.disconnect(); window.removeEventListener('resize', fit) }
  }, [width, height])

  const toPhoto = (e) => {
    const r = svgRef.current.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * width
    const y = ((e.clientY - r.top) / r.height) * height
    return [Math.min(width, Math.max(0, x)), Math.min(height, Math.max(0, y))]
  }
  const onDown = (i) => (e) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = i
  }
  const onMove = (e) => {
    if (drag.current === null) return
    const next = corners.map((c) => [...c])
    next[drag.current] = toPhoto(e)
    onChange(next)
  }
  const onUp = () => { drag.current = null }

  // sizes in photo pixels that look the same on any screen
  const px = (n) => (scale > 0 ? n / scale : n)
  const [tl, tr] = corners
  const top = [(tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2]
  const labels = ['crop.cornerTopLeft', 'crop.cornerTopRight', 'crop.cornerBottomRight', 'crop.cornerBottomLeft']

  return (
    // (room round the photo: a corner on its edge shows its whole handle)
    <div ref={boxRef} className="flex w-full justify-center px-4 py-4" data-sensitive="">
      <div className="relative select-none rounded-lg bg-stone-900" style={{ width: Math.round(width * scale), height: Math.round(height * scale) }}>
        {scale > 0 && <img src={url} alt="" draggable={false} className="pointer-events-none block h-full w-full rounded-lg" />}
        {scale > 0 && (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
            style={{ touchAction: 'none' }}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            data-testid="roster-photo-crop"
          >
            <polygon points={corners.map((c) => c.join(',')).join(' ')} fill="rgba(220,38,38,0.12)" stroke="#dc2626" strokeWidth={px(2)} strokeLinejoin="round" />
            <line x1={tl[0]} y1={tl[1]} x2={tr[0]} y2={tr[1]} stroke="#dc2626" strokeWidth={px(6)} strokeLinecap="round" />
            <text x={top[0]} y={top[1] - px(12)} textAnchor="middle" fontSize={px(14)} fontWeight="700" fill="#fff" stroke="#dc2626" strokeWidth={px(3)} paintOrder="stroke">{t('rosterPhoto.crop.top')}</text>
            {corners.map((c, i) => (
              <g key={i} onPointerDown={onDown(i)} style={{ cursor: 'grab' }} role="slider" aria-label={t(`rosterPhoto.${labels[i]}`)} aria-valuetext={`${Math.round(c[0])}, ${Math.round(c[1])}`} data-testid={`roster-photo-corner-${i}`}>
                {/* a finger-sized target around a small visible handle */}
                <circle cx={c[0]} cy={c[1]} r={px(26)} fill="transparent" />
                <circle cx={c[0]} cy={c[1]} r={px(11)} fill="#fff" stroke="#dc2626" strokeWidth={px(3)} />
              </g>
            ))}
          </svg>
        )}
      </div>
    </div>
  )
}
