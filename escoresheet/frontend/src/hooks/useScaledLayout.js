import { useScale } from '../contexts/ScaleContext'

/**
 * Hook for viewport-based scaling with user-configurable override.
 *
 * Design Philosophy:
 * - Content uses the vmin() function which converts vmin-like values to pixels
 * - The scale factor adjusts all sizes proportionally
 * - User can adjust the scale with a dropdown (50%-400%)
 * - Scale state is shared across all components via context
 *
 * Usage:
 *   const { vmin, scaleFactor } = useScaledLayout()
 *   style={{ width: vmin(8), height: vmin(8) }}  // 8vmin equivalent
 */

// Design baseline: the "virtual" viewport min dimension we design for (1000px)
// vmin(8) at baseline = 80px, scaled by scaleFactor
export const DESIGN_BASELINE = 1000

export function useScaledLayout() {
  // Use the shared context for scale state
  const scaleContext = useScale()

  return {
    ...scaleContext,
    DESIGN_BASELINE
  }
}

export default useScaledLayout
