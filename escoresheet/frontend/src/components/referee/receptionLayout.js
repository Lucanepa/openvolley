/**
 * Reception formation on the referee court: where the six discs of the
 * receiving team go, in px inside their court half, so that no two discs
 * overlap and none leaves the half.
 *
 * The formations (Referee.jsx getReceptionFormation, or positions the referee
 * dragged) are percentages: `top` is the distance from the net, `left` the
 * position across the court seen from behind the end line. Before, every disc
 * was drawn at 80 % of its standard size wherever the percentages put it; on
 * a large court (1920 x 1200) the discs grow faster than the gaps between
 * them, and disc I sat on disc II.
 *
 * Here the discs shrink (down to `minScale`) until the closest pair has room,
 * and if that is not enough (two dragged positions on top of each other) the
 * discs are pushed apart, then kept inside the half.
 *
 * "Room" is measured on the disc's square box, not the circle: the position,
 * replaced-player, captain and card marks sit in the box corners, so two
 * diagonal neighbours whose circles only touch still put a mark on the other
 * disc. Two boxes are clear when their centres are at least one box (plus
 * the gap) apart in x or in y.
 */

export const RECEPTION = {
  /** the formation's disc size, of the standard disc */
  maxScale: 0.8,
  /** never shrink a disc below this (badges and numbers stay readable) */
  minScale: 0.6,
  /** clear space between two discs: max(px, share of the drawn disc) */
  gapPx: 4,
  gapShare: 0.08,
  /** space kept between a disc and the half's edges (net, side lines) */
  edgePx: 3
}

const POSITIONS = ['I', 'II', 'III', 'IV', 'V', 'VI']

/**
 * A formation position in px inside the half (centre of the disc).
 * Left half: the net is on the right. Right half: the net is on the left and
 * the court is seen mirrored, so `left` runs bottom to top.
 */
export function formationPointPx(coords, side, width, height) {
  const fromNet = (coords?.top ?? 50) / 100
  const across = (coords?.left ?? 50) / 100
  return side === 'left'
    ? { x: width * (1 - fromNet), y: height * across }
    : { x: width * fromNet, y: height * (1 - across) }
}

/** Inverse of formationPointPx: a point in the half (px) to formation percentages. */
export function pointToFormation({ x, y }, side, width, height) {
  const px = width > 0 ? (x / width) * 100 : 50
  const py = height > 0 ? (y / height) * 100 : 50
  return side === 'left'
    ? { top: 100 - px, left: py }
    : { top: px, left: 100 - py }
}

/** Separation of two disc centres as square boxes: the larger of |dx| and |dy|. */
export const boxSeparation = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))

const clamp = (min, v, max) => (max < min ? (min + max) / 2 : Math.min(Math.max(v, min), max))

/**
 * Lay out a reception formation.
 * @param {{ formation: Record<string, {top:number,left:number}>, side: 'left'|'right', width: number, height: number, disc: number }} p
 *   width / height: the court half in px; disc: the standard disc diameter in px
 * @returns {{ scale: number, size: number, points: Record<string, {x:number,y:number}> }}
 *   scale: transform scale for each disc; size: the drawn diameter; points: disc centres in px
 */
export function layoutReception({ formation, side, width, height, disc }) {
  const R = RECEPTION
  const pts = POSITIONS.map((pos) => ({ pos, ...formationPointPx(formation?.[pos], side, width, height) }))
  const gapFor = (size) => Math.max(R.gapPx, size * R.gapShare)

  // 1. Shrink until the closest pair has room (not below minScale)
  let minDist = Infinity
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      minDist = Math.min(minDist, boxSeparation(pts[i], pts[j]))
    }
  }
  let scale = R.maxScale
  if (disc > 0 && minDist < disc * scale + gapFor(disc * scale)) {
    // size + max(gapPx, size * gapShare) <= minDist
    const bySharePx = minDist / (1 + R.gapShare)
    const byFixedPx = minDist - R.gapPx
    const size = Math.min(bySharePx, byFixedPx)
    scale = clamp(R.minScale, size / disc, R.maxScale)
  }
  const size = disc * scale
  const need = size + gapFor(size)
  const r = size / 2 + R.edgePx
  const keepIn = (p) => { p.x = clamp(r, p.x, width - r); p.y = clamp(r, p.y, height - r) }
  pts.forEach(keepIn)

  // 2. Push overlapping discs apart (positions dragged onto each other, or the
  //    shrink floor reached), keeping them inside the half
  for (let iter = 0; iter < 200; iter++) {
    let moved = false
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i]; const b = pts[j]
        const sep = boxSeparation(a, b)
        if (sep >= need - 0.01) continue
        let dx = b.x - a.x; let dy = b.y - a.y
        let dist = Math.hypot(dx, dy)
        if (dist < 0.01) { dx = (i % 2 ? -1 : 1) * 0.7; dy = 0.7; dist = 1 } // same spot: split diagonally
        const ux = dx / dist; const uy = dy / dist
        // moving both along u by `push` grows the box separation by 2 * push * max(|ux|, |uy|)
        const push = (need - sep) / (2 * Math.max(Math.abs(ux), Math.abs(uy))) + 0.05
        a.x -= ux * push; a.y -= uy * push
        b.x += ux * push; b.y += uy * push
        keepIn(a); keepIn(b)
        moved = true
      }
    }
    if (!moved) break
  }

  return { scale, size, points: Object.fromEntries(pts.map(({ pos, x, y }) => [pos, { x, y }])) }
}
