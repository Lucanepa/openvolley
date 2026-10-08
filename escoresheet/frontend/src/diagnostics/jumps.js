/**
 * Layout "jumps": a box whose size changes and comes back within a short
 * time (the scoreboard that pulses bigger / smaller for a moment on a point,
 * a rotation or a dialog). Fed with every size a ResizeObserver reports; WebKitGTK
 * has no layout-shift entries, so this is how a jump shows in the log.
 *
 *   const jumps = createJumpDetector({ windowMs: 500 })
 *   jumps.observe('court', 800, 400, t)  // -> null, or a jump:
 *   { key, size: [w, h], via: [[w, h], ...], ms }   (back to `size` after `ms`, through `via`)
 */
export const JUMP_WINDOW_MS = 500
// ResizeObserver sizes are fractional: within half a pixel is the same size
export const SAME_PX = 0.5

const same = (a, b) => Math.abs(a[0] - b[0]) <= SAME_PX && Math.abs(a[1] - b[1]) <= SAME_PX
const r1 = (n) => Math.round(n * 10) / 10

/**
 * @param {{ windowMs?: number, maxKeys?: number }} [opts]
 */
export function createJumpDetector({ windowMs = JUMP_WINDOW_MS, maxKeys = 200 } = {}) {
  // key -> [{ size: [w, h], t }] : the sizes the box had, oldest first; an
  // entry's t is when the box took that size
  const history = new Map()

  function observe(key, w, h, t) {
    const size = [r1(w), r1(h)]
    let list = history.get(key)
    if (!list) {
      if (history.size >= maxKeys) history.delete(history.keys().next().value)
      history.set(key, [{ size, t }])
      return null
    }
    const last = list[list.length - 1]
    if (same(last.size, size)) return null
    // the newest earlier size equal to this one, left no longer than windowMs ago
    let jump = null
    for (let i = list.length - 2; i >= 0; i--) {
      if (!same(list[i].size, size)) continue
      const leftAt = list[i + 1].t
      if (t - leftAt <= windowMs) {
        jump = { key, size, via: list.slice(i + 1).map(e => e.size), ms: Math.round(t - leftAt) }
      }
      break
    }
    list.push({ size, t })
    // keep the sizes a later jump could return to: within windowMs, and the one before them
    const since = t - windowMs
    let first = list.length - 1
    while (first > 0 && list[first].t >= since) first--
    if (first > 0) list = list.slice(first)
    history.set(key, list.slice(-20))
    return jump
  }

  return { observe, forget: (key) => history.delete(key), clear: () => history.clear() }
}
