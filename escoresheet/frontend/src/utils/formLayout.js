// Portrait data entry: when the scorer app's forms switch to one field per row.
//
// The scorer app only runs on screens it lets through its size gate
// (isViewportTooSmall below): a landscape screen at least 800x600, or a screen
// that is at least 800 tall and 600 wide, which is every tablet held upright
// (600x960, 768x1024, 800x1280, 834x1194 ...).
//
// Landscape screens that pass the gate (800x600 and up) keep the multi-column
// forms they were designed for. A tablet held upright is where the five-column
// match-info editor and the eight-column roster table get squeezed or cut off,
// so the forms stack there: orientation: portrait. A landscape screen narrower
// than 800 px only gets past the gate in fullscreen; it stacks too, since no
// multi-column form fits that width.
//
// The same query is the Tailwind `stack:` variant (src/tailwind.css) and the
// portrait block at the end of that file. Keep the three in step.
export const FORM_STACK_MAX_LANDSCAPE_WIDTH = 799.98
export const FORM_STACK_QUERY = `(orientation: portrait), (max-width: ${FORM_STACK_MAX_LANDSCAPE_WIDTH}px)`

/**
 * True when forms show one field per row for a viewport of this size
 * (mirrors FORM_STACK_QUERY: CSS calls a square viewport portrait).
 * @param {number} width  CSS px
 * @param {number} height CSS px
 */
export function isFormStacked(width, height) {
  return height >= width || width <= FORM_STACK_MAX_LANDSCAPE_WIDTH
}

/** Class the scorer app puts on <body> while its forms are stacked. */
export const FORM_STACK_CLASS = 'ov-form-stack'

/**
 * Keep FORM_STACK_CLASS on `el` exactly while FORM_STACK_QUERY matches, so
 * the portrait form rules (tailwind.css) reach the scorer app only, dialogs
 * portalled to <body> included. In landscape the class is never set, so the
 * page is the same DOM as before. Returns a function that stops watching.
 * @param {HTMLElement} el
 * @param {(query: string) => MediaQueryList} [matchMedia]
 */
export function watchFormStack(el, matchMedia = typeof window !== 'undefined' ? window.matchMedia?.bind(window) : undefined) {
  if (!el || !matchMedia) return () => {}
  const mq = matchMedia(FORM_STACK_QUERY)
  const apply = () => {
    if (mq.matches) el.classList.add(FORM_STACK_CLASS)
    else el.classList.remove(FORM_STACK_CLASS)
  }
  apply()
  mq.addEventListener?.('change', apply)
  return () => mq.removeEventListener?.('change', apply)
}

/**
 * The scorer app's minimum-size gate: blocks phones, lets tablets through in
 * either orientation. At least one side must reach 800 px and both 600 px.
 * @param {number} width  CSS px
 * @param {number} height CSS px
 */
export function isViewportTooSmall(width, height) {
  return (width < 800 && height < 800) || width < 600 || height < 600
}
