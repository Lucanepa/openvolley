/**
 * Player disc sizing on the referee court.
 *
 * Every size on a disc (the number, the corner badges, the sanction cards,
 * the serve ball) is a share of one length, the disc diameter `--disc`, and
 * the diameter comes from the court box (container query units on the court
 * grid). Before, the diameter came from the court, the number and the ball
 * from the viewport (vmin and the user scale) and the badges from the page
 * width (vw), so they grew apart: on a phone the two-digit numbers filled the
 * disc and the badges covered a third of it, and on a portrait tablet or a
 * desktop the serve ball was cut off at the court edge.
 *
 * The court (Referee.jsx): two halves side by side; each half is a two-column
 * grid, back row 1.5fr and front row 1fr, three discs per column, with padding
 * and gap clamp(4px, 2vw, 12px). The ball sits beside the server's disc, on
 * the end-line side of the back column.
 */

/** The court half's grid, as Referee.jsx lays it out. */
export const COURT_GRID = {
  backFr: 1.5,
  frontFr: 1,
  rows: 3,
  /** padding and gap: clamp(minPx, vw% of the viewport, maxPx) */
  spaceMinPx: 4,
  spaceVw: 2,
  spaceMaxPx: 12
}

/** Disc proportions. Badges stay inside the disc's square box. */
export const DISC = {
  /** three rows of discs plus the space around them in the court height */
  heightCqh: 26,
  /** fits the front column, and leaves the ball room in the back column */
  widthCqw: 15.5,
  /** the user scale (Options, 50 %) never shrinks a disc below this; only a small court does */
  minPx: 36,
  /** with LFP tracking on, three marks share the top edge: below this the LFP mark has no room between the corner badges */
  minPxLfp: 50,
  /** LFP mark type size, of the badge size */
  lfp: 0.46,
  /** player number font size, of the diameter (two digits fit inside the circle) */
  number: 0.5,
  /** corner badge size, of the diameter, held between min and max px */
  badge: 0.26,
  badgeMinPx: 11,
  badgeMaxPx: 26,
  /**
   * serve ball: up to this share of the diameter, less when the court is
   * narrow. It was 0.8: as big as a disc next to it, it read as a seventh
   * player and reached the court edge on a landscape tablet.
   */
  ballMax: 0.6,
  ballGap: 0.06,
  /** room for the ball beside a back-row disc: 15cqw minus half a disc (see discMetrics) */
  ballRoomCqw: 15,
  ballSafetyPx: 2
}

const PCT = (n) => Number((n).toFixed(4))

/** The disc's diameter cap in px: the viewport-based size the referee view used (8 vmin x 1.45, user scale applied; never below DISC.minPx). */
export function discCapPx(vmin) {
  return Math.round(vmin(8) * 1.45)
}

/**
 * CSS custom properties for one disc. Set them on the disc element (a child
 * of the court, which is the size container); the disc and its badges read
 * them with var().
 * @param {number} capPx largest diameter, in px
 * @param {{ lfp?: boolean }} [opts] lfp: LFP tracking on (the mark needs a larger floor)
 */
export function discCssVars(capPx, { lfp = false } = {}) {
  const d = DISC
  return {
    '--disc': `min(${d.heightCqh}cqh, ${d.widthCqw}cqw, ${Math.max(lfp ? d.minPxLfp : d.minPx, Math.round(capPx))}px)`,
    '--disc-number': `calc(var(--disc) * ${d.number})`,
    '--disc-badge': `clamp(${d.badgeMinPx}px, calc(var(--disc) * ${d.badge}), ${d.badgeMaxPx}px)`,
    '--disc-ball': `max(0px, min(calc(var(--disc) * ${d.ballMax}), calc(${d.ballRoomCqw}cqw - var(--disc) * ${PCT(0.5 + d.ballGap)} - ${d.ballSafetyPx}px)))`,
    '--disc-ball-gap': `calc(var(--disc) * ${d.ballGap})`
  }
}

const clamp = (min, v, max) => Math.min(Math.max(v, min), max)

/**
 * The same formulas in px, for a court of the given size.
 * @param {{ courtWidth: number, courtHeight: number, capPx: number, lfp?: boolean }} court
 */
export function discMetrics({ courtWidth, courtHeight, capPx, lfp = false }) {
  const d = DISC
  const cqw = courtWidth / 100
  const cqh = courtHeight / 100
  const disc = Math.max(0, Math.min(d.heightCqh * cqh, d.widthCqw * cqw, Math.max(lfp ? d.minPxLfp : d.minPx, Math.round(capPx))))
  return {
    disc,
    number: disc * d.number,
    badge: clamp(d.badgeMinPx, disc * d.badge, d.badgeMaxPx),
    ball: Math.max(0, Math.min(disc * d.ballMax, d.ballRoomCqw * cqw - disc * (0.5 + d.ballGap) - d.ballSafetyPx)),
    ballGap: disc * d.ballGap
  }
}

/**
 * What would overflow on a court of this size: discs that leave their column
 * or the court height, the serve ball past the court edge, numbers wider than
 * the circle. Empty when everything fits.
 * @param {{ courtWidth: number, courtHeight: number, viewportWidth: number, capPx: number, lfp?: boolean, digitEm?: number, capHeightEm?: number }} court
 * @returns {string[]}
 */
export function discFitProblems({ courtWidth, courtHeight, viewportWidth, capPx, lfp = false, digitEm = 0.7, capHeightEm = 0.73 }) {
  const g = COURT_GRID
  const m = discMetrics({ courtWidth, courtHeight, capPx, lfp })
  const problems = []
  const space = clamp(g.spaceMinPx, viewportWidth * g.spaceVw / 100, g.spaceMaxPx)
  const half = courtWidth / 2
  const columns = half - 2 * space - space
  const back = columns * g.backFr / (g.backFr + g.frontFr)
  const front = columns * g.frontFr / (g.backFr + g.frontFr)
  if (m.disc > front + 0.01) problems.push(`disc ${m.disc.toFixed(1)}px wider than the front column ${front.toFixed(1)}px`)
  if (g.rows * m.disc > courtHeight - 2 * space + 0.01) problems.push(`three discs ${(3 * m.disc).toFixed(1)}px taller than the court ${courtHeight}px`)
  // Disc centred in the back column; the ball goes to the court edge side.
  const roomBeside = space + (back - m.disc) / 2
  if (m.ball > 0 && m.ballGap + m.ball > roomBeside + 0.01) problems.push(`serve ball needs ${(m.ballGap + m.ball).toFixed(1)}px beside the disc, ${roomBeside.toFixed(1)}px there`)
  // Two digits, centred: their box's corners must stay inside the circle.
  const halfW = (2 * digitEm * m.number) / 2
  const halfH = (capHeightEm * m.number) / 2
  if (Math.hypot(halfW, halfH) > m.disc / 2 - 1) problems.push(`two-digit number ${m.number.toFixed(1)}px spills a ${m.disc.toFixed(1)}px disc`)
  if (m.badge > Math.max(m.disc * 0.4, DISC.badgeMinPx)) problems.push(`badge ${m.badge.toFixed(1)}px too big for a ${m.disc.toFixed(1)}px disc`)
  return problems
}
