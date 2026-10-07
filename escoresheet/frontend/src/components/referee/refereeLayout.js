/**
 * Referee page layout rules: how wide the page column gets, when the side
 * panels move beside the court, and when the screen is too small for the
 * court.
 *
 * Before, the page was a single column capped at 800 px with the TO / SUB
 * counters and the sanctions in a row under the court. On a landscape tablet
 * that left the court at most ~784 x 272 px (1280 x 800) with wide empty
 * margins, and the "screen too small" overlay fired on any screen under 650 px
 * high, covering courts that fit (962 x 601, a 10" Android tablet at DPR 2).
 *
 * Now:
 * - the column grows with the viewport up to `maxWidth` (1400 px);
 * - on a landscape screen (`isWideLayout`) the counters and sanctions sit in
 *   two side columns beside the court, so the court gets the height;
 * - the court box keeps a volleyball court's proportions (at most
 *   `courtMaxAspect` : 1, two 9 x 9 m halves plus room for the serve ball);
 * - the overlay shows only when the screen is narrower than `minWidth` or the
 *   court it gets cannot hold a disc of `DISC.minPx` (`screenFit`).
 */
import { DISC } from './discSizing.js'

export const REFEREE_LAYOUT = {
  /** the page column never gets wider than this */
  maxWidth: 1400,
  /** below this width nothing fits (the score row, the court halves) */
  minWidth: 357,
  /** wide (side panel) layout: at least this wide ... */
  wideMinWidth: 640,
  /** ... and at least this much wider than high */
  wideMinAspect: 1.15,
  /** side panel width in the wide layout: clamp(minPx, vw % of the viewport, maxPx) */
  sideMinPx: 128, // two 50 px sanction chips side by side, plus the panel's padding and margin
  sideVw: 11,
  sideMaxPx: 168,
  /** court box: share of its slot, and its widest proportion */
  courtFill: 0.98,
  courtMaxAspect: 2.2,
  /** a disc below this cannot show its number and marks: the screen is too small */
  minDiscPx: DISC.minPx
}

/** True when the referee page uses the landscape layout (side panels beside the court). */
export function isWideLayout(viewportWidth, viewportHeight) {
  const L = REFEREE_LAYOUT
  return viewportWidth >= L.wideMinWidth && viewportWidth >= viewportHeight * L.wideMinAspect
}

/** Width of the page column for a viewport this wide. */
export function columnWidth(viewportWidth) {
  return Math.min(viewportWidth, REFEREE_LAYOUT.maxWidth)
}

/** Width of one side panel (wide layout), as Referee.jsx sets it in CSS. */
export function sidePanelWidth(viewportWidth) {
  const L = REFEREE_LAYOUT
  return Math.min(Math.max(viewportWidth * L.sideVw / 100, L.sideMinPx), L.sideMaxPx)
}

/** CSS for the side panel column width (same rule as sidePanelWidth). */
export const SIDE_PANEL_CSS = `clamp(${REFEREE_LAYOUT.sideMinPx}px, ${REFEREE_LAYOUT.sideVw}vw, ${REFEREE_LAYOUT.sideMaxPx}px)`

/**
 * The court box inside a slot of this size: it fills `courtFill` of the slot
 * but is never wider than `courtMaxAspect` times its height.
 * @returns {{ width: number, height: number }}
 */
export function courtBoxInSlot(slotWidth, slotHeight) {
  const L = REFEREE_LAYOUT
  const height = Math.max(0, slotHeight * L.courtFill)
  const width = Math.max(0, Math.min(slotWidth * L.courtFill, height * L.courtMaxAspect))
  return { width, height }
}

/** The largest disc a court box allows (the size rule in discSizing, before the display-scale cap). */
export function courtDiscRoom(courtWidth, courtHeight) {
  return Math.max(0, Math.min(DISC.heightCqh * courtHeight / 100, DISC.widthCqw * courtWidth / 100))
}

/**
 * Whether the referee page fits this screen.
 * @param {{ viewportWidth: number, courtWidth?: number|null, courtHeight?: number|null }} s
 *   court*: the measured court box (content box); unknown before the first layout
 * @returns {{ fits: boolean, reason: null|'width'|'court', disc: number|null }}
 */
export function screenFit({ viewportWidth, courtWidth = null, courtHeight = null }) {
  const L = REFEREE_LAYOUT
  if (viewportWidth < L.minWidth) return { fits: false, reason: 'width', disc: null }
  if (courtWidth == null || courtHeight == null || (courtWidth === 0 && courtHeight === 0)) {
    // Not laid out yet (or hidden): only the width rule applies
    return { fits: true, reason: null, disc: null }
  }
  const disc = courtDiscRoom(courtWidth, courtHeight)
  if (disc < L.minDiscPx) return { fits: false, reason: 'court', disc }
  return { fits: true, reason: null, disc }
}
