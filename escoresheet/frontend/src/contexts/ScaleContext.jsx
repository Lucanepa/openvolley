import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from 'react'

// Context for sharing scale state across all components
const ScaleContext = createContext(null)

export function ScaleProvider({ children }) {
  // User scale override (null = auto / 1.0)
  const [userScaleOverride, setUserScaleOverrideState] = useState(() => {
    const saved = localStorage.getItem('userScaleOverride')
    return saved ? parseFloat(saved) : null
  })

  // Current viewport dimensions (prefer visualViewport for accuracy — excludes scrollbar)
  const getViewportSize = () => {
    if (typeof window === 'undefined') return { width: 1024, height: 768 }
    if (window.visualViewport) {
      return { width: window.visualViewport.width, height: window.visualViewport.height }
    }
    return { width: window.innerWidth, height: window.innerHeight }
  }

  const [viewport, setViewport] = useState(getViewportSize)

  // Throttle resize to one update per animation frame so rapid resize/scroll
  // (mobile browser chrome, orientation) doesn't trigger a re-render storm
  // across every scaled consumer (Scoreboard, MatchSetup).
  const rafRef = useRef(0)
  useEffect(() => {
    const handleResize = () => {
      if (rafRef.current) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        setViewport((prev) => {
          const next = getViewportSize()
          return (prev.width === next.width && prev.height === next.height) ? prev : next
        })
      })
    }
    window.addEventListener('resize', handleResize)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize)
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', handleResize)
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleResize)
      }
    }
  }, [])

  // Current viewport's vmin
  const viewportVmin = Math.min(viewport.width, viewport.height)

  // Scale factor: user override or 1.0 (clamped 0.5-1.5)
  const rawScale = userScaleOverride ?? 1.0
  const scaleFactor = Math.min(Math.max(rawScale, 0.5), 1.5)

  // Update CSS custom properties on the root element for CSS-based scaling
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--scale-factor', scaleFactor.toString())
    root.style.setProperty('--vmin-base', `${viewportVmin}px`)
  }, [scaleFactor, viewportVmin])

  // vmin conversion: converts vmin-like value to pixels
  const vmin = useCallback((value) => {
    return (viewportVmin * (value / 100)) * scaleFactor
  }, [viewportVmin, scaleFactor])

  // Set user scale override with localStorage persistence
  const setUserScaleOverride = useCallback((val) => {
    setUserScaleOverrideState(val)
    if (val === null) {
      localStorage.removeItem('userScaleOverride')
    } else {
      localStorage.setItem('userScaleOverride', val.toString())
    }
  }, [])

  // Reset to auto scale (1.0)
  const resetToAuto = useCallback(() => {
    setUserScaleOverrideState(null)
    localStorage.removeItem('userScaleOverride')
  }, [])

  const value = useMemo(() => ({
    scaleFactor,
    vmin,
    viewport,
    viewportVmin,
    userScaleOverride,
    setUserScaleOverride,
    resetToAuto
  }), [scaleFactor, vmin, viewport, viewportVmin, userScaleOverride, setUserScaleOverride, resetToAuto])

  return (
    <ScaleContext.Provider value={value}>
      {children}
    </ScaleContext.Provider>
  )
}

export function useScale() {
  const context = useContext(ScaleContext)
  if (!context) {
    throw new Error('useScale must be used within a ScaleProvider')
  }
  return context
}

export default ScaleContext
