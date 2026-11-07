// The desktop app on a Point Hub board's touchscreen: pointhub-screen starts it with
// OPENVOLLEY_POINTHUB_BOARD, and src-tauri/src/main.rs sets this flag before the page loads.
export const onPointHubBoard = () => typeof window !== 'undefined' && window.__OV_POINTHUB_BOARD__ === true

const NOT_TYPED_IN = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])

export function isTextField(el) {
  if (!el) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true
  return el.tagName === 'INPUT' && !NOT_TYPED_IN.has(el.type)
}

/**
 * What the board's on-screen keyboard needs from the page. It opens by shrinking the
 * window, and the desktop webview leaves the field where it was, behind the keyboard:
 * the field is scrolled into view at every resize. And it has no key to close it, only
 * a tap outside the field: Enter in a one-line field closes it too, unless the Enter
 * moved the focus on (a form that went on to its next field).
 * @param {Window} [win]
 * @returns {() => void} removes the listeners
 */
export function installOnScreenKeyboardHelp(win = window) {
  const doc = win.document
  let frame = 0
  const onResize = () => {
    if (frame) return
    // Two frames: ScaleContext commits the new size in the first
    frame = win.requestAnimationFrame(() => {
      frame = win.requestAnimationFrame(() => {
        frame = 0
        const el = doc.activeElement
        if (isTextField(el)) el.scrollIntoView({ block: 'center', inline: 'nearest' })
      })
    })
  }
  const onKeyDown = (e) => {
    const field = e.target
    if (e.key !== 'Enter' || e.isComposing || !isTextField(field)) return
    if (field.tagName === 'TEXTAREA' || field.isContentEditable) return
    win.setTimeout(() => {
      if (doc.activeElement === field) field.blur()
    }, 0)
  }
  win.addEventListener('resize', onResize)
  doc.addEventListener('keydown', onKeyDown)
  return () => {
    win.removeEventListener('resize', onResize)
    doc.removeEventListener('keydown', onKeyDown)
    if (frame) win.cancelAnimationFrame(frame)
  }
}
