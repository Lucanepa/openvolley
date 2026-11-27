/**
 * A photo of a list made into a flat, even page for the text recognition
 * (docs/roster-photo-spec.md, plan A): the page's four corners (a first
 * guess the scorer moves), the page cut out and its perspective undone, the
 * light evened out (shadows, a lamp on one side), the contrast stretched and
 * the table's rules taken out. Grey, as the recognition reads it.
 *
 * No library (OpenCV.js is ~9 MB and slow on a Galaxy Tab A7 Lite): a
 * homography and a few passes over the pixels. The pure functions take and
 * give plain arrays, so they run in tests without a canvas.
 */

// The photo as it is worked on and shown: a camera's 12 MP would take ~50 MB
// of pixels on a 3 GB tablet. 2400 px keeps an A4 list's small print readable.
export const PHOTO_MAX_SIDE = 2400
// The flat page handed to the recognition: about 260 dpi for an A4 page
export const PAGE_MAX_SIDE = 2200
// The corner guess works on a small copy
const GUESS_SIDE = 320

/** [tl, tr, br, bl] of four points, whatever their order. */
export function orderCorners (points) {
  const pts = points.map(([x, y]) => [x, y])
  const bySum = [...pts].sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]))
  const byDiff = [...pts].sort((a, b) => (a[0] - a[1]) - (b[0] - b[1]))
  return [bySum[0], byDiff[3], bySum[3], byDiff[0]]
}

/** The corners turned a quarter (steps 1..3): the page comes out turned 90° clockwise per step. */
export function rotateCorners (corners, steps = 1) {
  const n = ((steps % 4) + 4) % 4
  return corners.map((_, i) => corners[(i + 4 - n) % 4])
}

/**
 * The 3x3 matrix (row-major, 9 numbers) taking each src point to its dst
 * point (four of each). Gaussian elimination of the 8 x 8 system; null when
 * the points are degenerate (three on a line).
 */
export function homography (src, dst) {
  const a = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [u, v] = dst[i]
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  for (let c = 0; c < 8; c++) {
    let pivot = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r
    if (Math.abs(a[pivot][c]) < 1e-12) return null
    ;[a[c], a[pivot]] = [a[pivot], a[c]]
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = a[r][c] / a[c][c]
      for (let k = c; k < 9; k++) a[r][k] -= f * a[c][k]
    }
  }
  const h = a.map((row, i) => row[8] / row[i])
  return [...h, 1]
}

/** Where H takes the point (x, y). */
export function project (h, x, y) {
  const w = h[6] * x + h[7] * y + h[8]
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1])

/**
 * The flat page's size from its corners (the longer of each pair of edges),
 * its longer side at most maxSide. A small page (a phone's screenshot of
 * the list) is enlarged, up to twice: Tesseract reads letters about 20 px
 * high best, a screenshot's are often 8.
 */
export function pageSize (corners, maxSide = PAGE_MAX_SIDE) {
  const [tl, tr, br, bl] = corners
  const w = Math.max(dist(tl, tr), dist(bl, br))
  const h = Math.max(dist(tl, bl), dist(tr, br))
  const f = Math.min(2, maxSide / Math.max(w, h, 1))
  return { width: Math.max(1, Math.round(w * f)), height: Math.max(1, Math.round(h * f)) }
}

/** Grey (0..255) of RGBA pixels. */
export function toGray (rgba, width, height) {
  const out = new Uint8ClampedArray(width * height)
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8
  return out
}

/**
 * The page inside `corners` of the RGBA source, flat and grey, width x height:
 * each page pixel looked up through the homography, bilinear.
 */
export function warpGray (rgba, srcWidth, srcHeight, corners, width, height) {
  const h = homography([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], corners)
  const out = new Uint8ClampedArray(width * height)
  if (!h) return out
  const lum = (x, y) => {
    const j = (y * srcWidth + x) * 4
    return (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [sx, sy] = project(h, x, y)
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      if (x0 < 0 || y0 < 0 || x0 >= srcWidth - 1 || y0 >= srcHeight - 1) { out[y * width + x] = 255; continue }
      const fx = sx - x0
      const fy = sy - y0
      const top = lum(x0, y0) * (1 - fx) + lum(x0 + 1, y0) * fx
      const bottom = lum(x0, y0 + 1) * (1 - fx) + lum(x0 + 1, y0 + 1) * fx
      out[y * width + x] = top * (1 - fy) + bottom * fy
    }
  }
  return out
}

/**
 * The light made even: each pixel divided by the page's brightness around it
 * (the brightest of 16 x 16 blocks, smoothed: paper, not ink), so a shadow
 * or a lamp on one side no longer darkens a part of the page.
 */
export function evenLight (gray, width, height, block = 16) {
  const bw = Math.ceil(width / block)
  const bh = Math.ceil(height / block)
  let bg = new Float32Array(bw * bh)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let max = 0
      const yEnd = Math.min(height, (by + 1) * block)
      const xEnd = Math.min(width, (bx + 1) * block)
      for (let y = by * block; y < yEnd; y++) for (let x = bx * block; x < xEnd; x++) if (gray[y * width + x] > max) max = gray[y * width + x]
      bg[by * bw + bx] = max
    }
  }
  // a block that is all ink (a heading, a dark logo) takes its neighbours' paper
  for (let pass = 0; pass < 3; pass++) {
    const next = new Float32Array(bg.length)
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let sum = 0
        let n = 0
        let max = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = bx + dx
            const y = by + dy
            if (x < 0 || y < 0 || x >= bw || y >= bh) continue
            const v = bg[y * bw + x]
            sum += v
            n++
            if (v > max) max = v
          }
        }
        next[by * bw + bx] = (sum / n + max) / 2
      }
    }
    bg = next
  }
  const out = new Uint8ClampedArray(gray.length)
  for (let y = 0; y < height; y++) {
    const gy = Math.min(bh - 1, Math.max(0, (y + 0.5) / block - 0.5))
    const y0 = Math.floor(gy)
    const y1 = Math.min(bh - 1, y0 + 1)
    const fy = gy - y0
    for (let x = 0; x < width; x++) {
      const gx = Math.min(bw - 1, Math.max(0, (x + 0.5) / block - 0.5))
      const x0 = Math.floor(gx)
      const x1 = Math.min(bw - 1, x0 + 1)
      const fx = gx - x0
      const b = (bg[y0 * bw + x0] * (1 - fx) + bg[y0 * bw + x1] * fx) * (1 - fy) +
        (bg[y1 * bw + x0] * (1 - fx) + bg[y1 * bw + x1] * fx) * fy
      out[y * width + x] = (gray[y * width + x] * 255) / Math.max(b, 24)
    }
  }
  return out
}

/** The contrast stretched: the darkest 1 % black, the brightest 5 % (the paper) white. In place. */
export function stretchContrast (gray) {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const at = (share) => {
    let n = 0
    for (let v = 0; v < 256; v++) { n += hist[v]; if (n >= share * gray.length) return v }
    return 255
  }
  const lo = at(0.01)
  const hi = Math.max(lo + 1, at(0.95))
  const lut = new Uint8ClampedArray(256)
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo)
  for (let i = 0; i < gray.length; i++) gray[i] = lut[gray[i]]
  return gray
}

/**
 * The table's rules taken out (in place): runs of ink longer than a letter
 * could be, across (minShare of the width) or down (of the height), and the
 * pixel beside them. Tesseract misreads every letter that touches a cell's
 * border ("[223451" for 123451, "|tuca" for Luca); without the rules the
 * cells read as plain text in columns.
 */
export function removeRules (gray, width, height, { minShareAcross = 0.04, minShareDown = 0.03, maxThickShare = 0.003 } = {}) {
  const t = Math.min(200, otsuThreshold(gray) + 10)
  const across = Math.max(20, Math.round(width * minShareAcross))
  const down = Math.max(20, Math.round(height * minShareDown))
  // a rule is thin; a word whose letters ran together (blur) is as thick as its letters
  const thick = Math.max(3, Math.round(Math.max(width, height) * maxThickShare))
  const ink = (x, y) => gray[y * width + x] < t
  // paper (or the page's edge) at `o` across a run, `i` along it
  const paper = (alongWidth, o, i) => {
    const [x, y] = alongWidth ? [i, o] : [o, i]
    return x < 0 || y < 0 || x >= width || y >= height || !ink(x, y)
  }
  // runs of ink of at least `min` along one direction, kept where at most `thick` deep across it
  const runs = (alongWidth) => {
    const mask = new Uint8Array(width * height)
    const [outer, inner, min] = alongWidth ? [height, width, across] : [width, height, down]
    const at = (o, i) => (alongWidth ? o * width + i : i * width + o)
    for (let o = 0; o < outer; o++) {
      let start = -1
      for (let i = 0; i <= inner; i++) {
        const on = i < inner && (alongWidth ? ink(i, o) : ink(o, i))
        if (on && start < 0) start = i
        if (!on && start >= 0) {
          // a rule has paper on both sides along most of its length; letters
          // that ran together have their strokes above and below
          if (i - start >= min) {
            let clear = 0
            for (let k = start; k < i; k++) if (paper(alongWidth, o - thick - 1, k) && paper(alongWidth, o + thick + 1, k)) clear++
            if (clear >= 0.6 * (i - start)) for (let k = start; k < i; k++) mask[at(o, k)] = 1
          }
          start = -1
        }
      }
    }
    // the depth across: consecutive marked pixels at a right angle
    for (let i = 0; i < inner; i++) {
      let start = -1
      for (let o = 0; o <= outer; o++) {
        const on = o < outer && mask[at(o, i)] === 1
        if (on && start < 0) start = o
        if (!on && start >= 0) {
          if (o - start > thick) for (let k = start; k < o; k++) mask[at(k, i)] = 0
          start = -1
        }
      }
    }
    return mask
  }
  const across_ = runs(true)
  const down_ = runs(false)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (!across_[i] && !down_[i]) continue
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx >= 0 && xx < width) gray[yy * width + xx] = 255
        }
      }
    }
  }
  return gray
}

/** Otsu's threshold of grey values: the one that best splits paper from the rest. */
export function otsuThreshold (gray) {
  const hist = new Float64Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  let sumAll = 0
  for (let v = 0; v < 256; v++) sumAll += v * hist[v]
  let wB = 0
  let sumB = 0
  let best = 0
  let threshold = 127
  for (let v = 0; v < 256; v++) {
    wB += hist[v]
    if (!wB) continue
    const wF = gray.length - wB
    if (!wF) break
    sumB += v * hist[v]
    const between = wB * wF * (sumB / wB - (sumAll - sumB) / wF) ** 2
    if (between > best) { best = between; threshold = v }
  }
  return threshold
}

/**
 * The page's corners in a small grey copy (width x height): the largest
 * bright region (paper is brighter than a table, a floor or a hand), and the
 * four-sided shape round it (quadOfHull: a corner cut off by a shadow, a hand
 * or the photo's edge is where the page's two long edges meet, not the
 * region's extreme point). null when no bright region covers a fifth of the
 * photo (a close-up of the page: the scorer drags the corners).
 */
export function cornersFromGray (gray, width, height) {
  const t = otsuThreshold(gray)
  const label = new Int32Array(width * height).fill(-1)
  let best = null
  const stack = []
  for (let start = 0; start < label.length; start++) {
    if (label[start] !== -1 || gray[start] <= t) continue
    const id = start
    const region = { id, n: 0, tl: null, tr: null, br: null, bl: null }
    label[start] = id
    stack.push(start)
    while (stack.length) {
      const i = stack.pop()
      const x = i % width
      const y = (i - x) / width
      region.n++
      if (!region.tl || x + y < region.tl[0] + region.tl[1]) region.tl = [x, y]
      if (!region.br || x + y > region.br[0] + region.br[1]) region.br = [x, y]
      if (!region.tr || x - y > region.tr[0] - region.tr[1]) region.tr = [x, y]
      if (!region.bl || x - y < region.bl[0] - region.bl[1]) region.bl = [x, y]
      const next = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]
      for (const j of next) {
        if (j >= 0 && label[j] === -1 && gray[j] > t) { label[j] = id; stack.push(j) }
      }
    }
    if (!best || region.n > best.n) best = region
  }
  if (!best || best.n < 0.2 * width * height) return null
  // the page fills the picture (a screenshot, a close-up): its edges are the page's
  if (best.n > 0.85 * width * height) return [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]]
  // the region's outline: its first and last pixel on each row and column
  const inRegion = (x, y) => label[y * width + x] === best.id
  const left = []
  const right = []
  const top = []
  const bottom = []
  for (let y = 0; y < height; y++) {
    let first = -1
    let last = -1
    for (let x = 0; x < width; x++) if (inRegion(x, y)) { if (first < 0) first = x; last = x }
    if (first >= 0) { left.push([first, y]); right.push([last, y]) }
  }
  for (let x = 0; x < width; x++) {
    let first = -1
    let last = -1
    for (let y = 0; y < height; y++) if (inRegion(x, y)) { if (first < 0) first = y; last = y }
    if (first >= 0) { top.push([x, first]); bottom.push([x, last]) }
  }
  // two guesses, the one whose shape covers the region best wins: the hull's
  // (a page turned far, a corner cut off) and the straight edges' (something
  // bright touching the page: a hand, a second sheet, a reflection)
  const candidates = [
    quadOfHull(convexHull([...left, ...right]), width, height),
    quadOfEdges({ left, right, top, bottom }, width, height)
  ].filter(Boolean).map(orderCorners)
  let pick = null
  for (const q of candidates) {
    const f = quadFit(q, inRegion, width, height, best.n)
    if (!pick || f > pick.f) pick = { q, f }
  }
  return pick ? pick.q : [best.tl, best.tr, best.br, best.bl]
}

/** Whether (x, y) lies inside the convex quad [tl, tr, br, bl] (either winding). */
function insideQuad (q, x, y) {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i]
    const [bx, by] = q[(i + 1) % 4]
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
    if (c === 0) continue
    if (sign && Math.sign(c) !== sign) return false
    sign = Math.sign(c)
  }
  return true
}

/** How well a quad matches the region: the F-score of the pixels inside it against the region's. */
function quadFit (q, inRegion, width, height, regionSize) {
  let inside = 0
  let both = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!insideQuad(q, x + 0.5, y + 0.5)) continue
      inside++
      if (inRegion(x, y)) both++
    }
  }
  return inside && regionSize ? (2 * both) / (inside + regionSize) : 0
}

/**
 * The line most points of one side of the outline lie on (within 2 % of the
 * photo): pairs of points spread along the side tried in turn (no chance: the
 * same photo gives the same corners), then fitted to the points near the best.
 * byY: the side runs down (left, right), so x is a function of y.
 * @returns {{ a: number[], b: number[] } | null} two points on it
 */
function edgeLine (points, byY, tolerance) {
  if (points.length < 8) return null
  const u = (p) => (byY ? p[1] : p[0])
  const v = (p) => (byY ? p[0] : p[1])
  const SAMPLES = 24
  const maxGap = Math.max(2, Math.round(points.length * 0.03))
  const picks = Array.from({ length: SAMPLES }, (_, i) => points[Math.round((i * (points.length - 1)) / (SAMPLES - 1))])
  let best = null
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = i + 1; j < SAMPLES; j++) {
      const p = picks[i]
      const q = picks[j]
      if (u(q) === u(p)) continue
      const m = (v(q) - v(p)) / (u(q) - u(p))
      if (Math.abs(m) > 1.2) continue
      const c = v(p) - m * u(p)
      // the points on it, and again those of its longest stretch: a page's
      // edge is mostly one piece; a line across a bump (a hand) and the far
      // end of the edge is two. (Not the stretch alone: something dark lying
      // on the page's edge cuts it in two, and the dark thing's straight
      // side is one.)
      let all = 0
      let longest = 0
      let run = 0
      let gap = 0
      for (const r of points) {
        if (Math.abs(v(r) - (m * u(r) + c)) <= tolerance) { all++; run++; gap = 0 } else if (++gap > maxGap) run = 0
        if (run > longest) longest = run
      }
      const n = all + longest
      if (!best || n > best.n) best = { m, c, n, all }
    }
  }
  if (!best || best.all < 0.3 * points.length) return null
  // least squares over the points near it
  let su = 0
  let sv = 0
  let suu = 0
  let suv = 0
  let k = 0
  for (const r of points) {
    if (Math.abs(v(r) - (best.m * u(r) + best.c)) > tolerance) continue
    su += u(r); sv += v(r); suu += u(r) * u(r); suv += u(r) * v(r); k++
  }
  const d = k * suu - su * su
  const m = Math.abs(d) > 1e-9 ? (k * suv - su * sv) / d : best.m
  const c = (sv - m * su) / k
  const at = (t) => (byY ? [m * t + c, t] : [t, m * t + c])
  return { a: at(0), b: at(1000) }
}

/** The quad of the page's four straight edges (edgeLine on each side of the outline), or null. */
export function quadOfEdges ({ left, right, top, bottom }, width, height) {
  const tol = 0.02 * Math.max(width, height)
  const lines = [edgeLine(top, false, tol), edgeLine(right, true, tol), edgeLine(bottom, false, tol), edgeLine(left, true, tol)]
  if (lines.some((l) => !l)) return null
  const meet = (s, t) => {
    const [x1, y1] = s.a
    const [x2, y2] = s.b
    const [x3, y3] = t.a
    const [x4, y4] = t.b
    const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if (Math.abs(d) < 1e-9) return null
    const a = x1 * y2 - y1 * x2
    const b = x3 * y4 - y3 * x4
    return [(a * (x3 - x4) - (x1 - x2) * b) / d, (a * (y3 - y4) - (y1 - y2) * b) / d]
  }
  const corners = [meet(lines[3], lines[0]), meet(lines[0], lines[1]), meet(lines[1], lines[2]), meet(lines[2], lines[3])]
  const near = (p) => p && p[0] > -0.25 * width && p[0] < 1.25 * width && p[1] > -0.25 * height && p[1] < 1.25 * height
  return corners.every(near) ? corners : null
}

/** The convex hull of points (Andrew's monotone chain), in order round it. */
export function convexHull (points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list) => {
    const out = []
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop()
      out.push(q)
    }
    out.pop()
    return out
  }
  return [...half(p), ...half(p.reverse())]
}

/**
 * The page's four corners from the hull of its bright region: the hull's
 * edges joined into straight sides, the four sides that turn like a page's
 * (each about a right angle from the next) and are longest together, and
 * where each meets the next. A corner a shadow, a hand or the photo's edge
 * took away is a short side between two long ones, left out, so the long
 * ones meet where the page's corner is. null when no four sides do.
 */
export function quadOfHull (hull, width, height) {
  const n = hull.length
  if (n < 4) return null
  const angle = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0])
  const turn = (a1, a2) => {
    let d = a2 - a1
    while (d <= -Math.PI) d += 2 * Math.PI
    while (d > Math.PI) d -= 2 * Math.PI
    return d
  }
  // start at the sharpest bend, so no side is split at the list's start
  let start = 0
  let sharpest = -1
  for (let i = 0; i < n; i++) {
    const t = Math.abs(turn(angle(hull[(i + n - 1) % n], hull[i]), angle(hull[i], hull[(i + 1) % n])))
    if (t > sharpest) { sharpest = t; start = i }
  }
  const STRAIGHT = (14 * Math.PI) / 180
  const sides = []
  let side = null
  for (let k = 0; k < n; k++) {
    const a = hull[(start + k) % n]
    const b = hull[(start + k + 1) % n]
    if (side && Math.abs(turn(angle(side.a, side.b), angle(a, b))) < STRAIGHT && Math.abs(turn(angle(side.a, b), angle(a, b))) < STRAIGHT) side.b = b
    else {
      if (side) sides.push(side)
      side = { a, b }
    }
  }
  sides.push(side)
  for (const s of sides) { s.len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]); s.dir = angle(s.a, s.b) }
  const meet = (s, u) => {
    const [x1, y1] = s.a
    const [x2, y2] = s.b
    const [x3, y3] = u.a
    const [x4, y4] = u.b
    const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if (Math.abs(d) < 1e-9) return null
    const a = x1 * y2 - y1 * x2
    const b = x3 * y4 - y3 * x4
    return [(a * (x3 - x4) - (x1 - x2) * b) / d, (a * (y3 - y4) - (y1 - y2) * b) / d]
  }
  const m = sides.length
  if (m < 4) return null
  const near = (p) => p && p[0] > -0.25 * width && p[0] < 1.25 * width && p[1] > -0.25 * height && p[1] < 1.25 * height
  let best = null
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      for (let k = j + 1; k < m; k++) {
        for (let l = k + 1; l < m; l++) {
          const four = [sides[i], sides[j], sides[k], sides[l]]
          const len = four.reduce((sum, s) => sum + s.len, 0)
          if (best && len <= best.len) continue
          let ok = true
          for (let q = 0; q < 4 && ok; q++) {
            const t = Math.abs(turn(four[q].dir, four[(q + 1) % 4].dir))
            ok = t > (50 * Math.PI) / 180 && t < (130 * Math.PI) / 180
          }
          if (!ok) continue
          const corners = four.map((s, q) => meet(four[(q + 3) % 4], s))
          if (!corners.every(near)) continue
          best = { len, corners }
        }
      }
    }
  }
  return best ? best.corners : null
}

/**
 * How much of a ring of ink lies around a word (a number circled by hand:
 * the team's captain, owner 2026-11-23): 0..1, the share of 32 rays from the
 * word's centre that meet ink outside its box, with each quarter counted on
 * its own and the weakest quarter returned, so text beside the number (the
 * SV number to its right) never makes a ring. (A circle the recognition took
 * into the word's box is ringInRegion's.)
 * @param {{ x0, y0, x1, y1 }} box in the page's pixels
 */
export function ringScore (gray, width, height, box, { ink = 128 } = {}) {
  const cx = (box.x0 + box.x1) / 2
  const cy = (box.y0 + box.y1) / 2
  const hw = Math.max(1, (box.x1 - box.x0) / 2)
  const hh = Math.max(1, (box.y1 - box.y0) / 2)
  const reach = 2 * Math.max(hw, hh) + 4
  const RAYS = 32
  const quarters = [0, 0, 0, 0]
  for (let k = 0; k < RAYS; k++) {
    const a = ((k + 0.5) / RAYS) * 2 * Math.PI
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    // where the ray leaves the word's box
    const edge = Math.min(Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity)
    for (let t = edge + 1; t <= edge + reach; t += 1) {
      const x = Math.round(cx + dx * t)
      const y = Math.round(cy + dy * t)
      if (x < 0 || y < 0 || x >= width || y >= height) break
      if (gray[y * width + x] < ink) { quarters[Math.floor((k / RAYS) * 4)]++; break }
    }
  }
  return Math.min(...quarters) / (RAYS / 4)
}

/**
 * A circle drawn by hand in a region of the page (left of a row's SV number,
 * where a team writes the shirt number): a ring of ink between 1.3 and 5
 * text lines across, roughly round, hollow, with other ink inside it (the
 * number; a big handwritten 0 alone is no circle). The recognition often
 * skips a circled number; this finds the circle, and the box inside it is
 * read again for the digits. null when there is none.
 * @param {{ x0, y0, x1, y1 }} region page pixels
 * @param {number} line the height of a line of print, in pixels
 * @returns {{ ring: {x0,y0,x1,y1}, inner: {x0,y0,x1,y1} } | null}
 */
export function ringInRegion (gray, width, height, region, line, { ink = 128 } = {}) {
  const x0 = Math.max(0, Math.floor(region.x0))
  const y0 = Math.max(0, Math.floor(region.y0))
  const x1 = Math.min(width, Math.ceil(region.x1))
  const y1 = Math.min(height, Math.ceil(region.y1))
  const w = x1 - x0
  const h = y1 - y0
  if (w < 4 || h < 4) return null
  const label = new Int32Array(w * h)
  const parts = []
  for (let start = 0; start < label.length; start++) {
    if (label[start] || gray[(y0 + Math.floor(start / w)) * width + x0 + (start % w)] >= ink) continue
    const id = parts.length + 1
    const part = { n: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1 }
    const stack = [start]
    label[start] = id
    while (stack.length) {
      const i = stack.pop()
      const x = i % w
      const y = (i - x) / w
      part.n++
      if (x < part.x0) part.x0 = x
      if (x > part.x1) part.x1 = x
      if (y < part.y0) part.y0 = y
      if (y > part.y1) part.y1 = y
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (!label[j] && gray[(y0 + ny) * width + x0 + nx] < ink) { label[j] = id; stack.push(j) }
      }
    }
    parts.push(part)
  }
  for (const r of parts) {
    const rw = r.x1 - r.x0 + 1
    const rh = r.y1 - r.y0 + 1
    if (rw < 1.3 * line || rh < 1.3 * line || rw > 5 * line || rh > 5 * line) continue
    if (rw / rh < 0.55 || rw / rh > 1.8) continue
    // a ring: thin ink around the edge, not a filled blob
    if (r.n > 0.4 * rw * rh) continue
    const ringBox = { x0: x0 + r.x0, y0: y0 + r.y0, x1: x0 + r.x1, y1: y0 + r.y1 }
    // the ink of other parts inside the ring's middle (the number)
    const inside = parts.filter((q) => q !== r && q.x0 > r.x0 && q.x1 < r.x1 && q.y0 > r.y0 && q.y1 < r.y1)
    if (!inside.length) continue
    const inner = {
      x0: x0 + Math.min(...inside.map((q) => q.x0)),
      y0: y0 + Math.min(...inside.map((q) => q.y0)),
      x1: x0 + Math.max(...inside.map((q) => q.x1)),
      y1: y0 + Math.max(...inside.map((q) => q.y1))
    }
    // the ring goes all the way round its contents: its pixels, by their
    // angle seen from the middle of the contents, in 32 sectors, each
    // quarter at least three quarters full
    const id = parts.indexOf(r) + 1
    const cx = (inner.x0 + inner.x1) / 2 - x0
    const cy = (inner.y0 + inner.y1) / 2 - y0
    const sectors = new Uint8Array(32)
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        if (label[y * w + x] !== id) continue
        const a = Math.atan2(y - cy, x - cx)
        sectors[Math.min(31, Math.floor(((a + Math.PI) / (2 * Math.PI)) * 32))] = 1
      }
    }
    const quarters = [0, 1, 2, 3].map((q) => sectors.slice(q * 8, q * 8 + 8).reduce((n, v) => n + v, 0))
    if (Math.min(...quarters) < 6) continue
    return { ring: ringBox, inner }
  }
  return null
}

/**
 * The handwriting on a player row: groups of ink in the row's band that no
 * printed word explains (region.skip: the words' boxes), from left of the SV
 * number (region.x0) up to the date (region.x1), and right of the printed
 * table (region.beyond). A part counts when its middle is on the row (a big
 * number reaches into the next one), when it is no speck and no rule;
 * parts less than a line apart are one group ("3K", "99 L2"). Ink is
 * anything darker than light grey: a thin pen reads far paler than print.
 * @param {{ x0, x1, y, line, skip: {x0,y0,x1,y1}[], beyond: number|null }} region page pixels
 * @returns {{ x0, y0, x1, y1, where: 'left'|'inside'|'right' }[]} left to right
 */
export function handInk (gray, width, height, region, { ink = 190, leftOf = Infinity } = {}) {
  const { line } = region
  const top = Math.max(0, Math.floor(region.y - 1.8 * line))
  const bottom = Math.min(height, Math.ceil(region.y + 1.8 * line))
  const spans = [[Math.max(0, Math.floor(region.x0)), Math.min(width, Math.ceil(region.x1))]]
  if (Number.isFinite(region.beyond) && region.beyond < width - line) spans.push([Math.ceil(region.beyond), width])
  const pad = 0.15 * line
  const skip = (region.skip || []).map((b) => ({ x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad }))
  const parts = []
  for (const [x0, x1] of spans) {
    const w = x1 - x0
    const h = bottom - top
    if (w < 2 || h < 2) continue
    const seen = new Uint8Array(w * h)
    for (let start = 0; start < seen.length; start++) {
      if (seen[start] || gray[(top + Math.floor(start / w)) * width + x0 + (start % w)] >= ink) continue
      const part = { n: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1 }
      const stack = [start]
      seen[start] = 1
      while (stack.length) {
        const i = stack.pop()
        const x = i % w
        const y = (i - x) / w
        part.n++
        if (x < part.x0) part.x0 = x
        if (x > part.x1) part.x1 = x
        if (y < part.y0) part.y0 = y
        if (y > part.y1) part.y1 = y
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const j = ny * w + nx
          if (!seen[j] && gray[(top + ny) * width + x0 + nx] < ink) { seen[j] = 1; stack.push(j) }
        }
      }
      const box = { x0: x0 + part.x0, y0: top + part.y0, x1: x0 + part.x1 + 1, y1: top + part.y1 + 1, n: part.n }
      const bw = box.x1 - box.x0
      const bh = box.y1 - box.y0
      // a speck, a rule or a pen line across the row, a part off the row
      if (Math.max(bw, bh) < 0.3 * line || part.n < 0.04 * line * line || bw > 6 * line || bh > 3.5 * line) continue
      if (Math.abs((box.y0 + box.y1) / 2 - region.y) > 0.9 * line) continue
      // ink of a printed word (its letters reach a little out of its box)
      const area = bw * bh
      const covered = skip.reduce((m, b) => Math.max(m, Math.max(0, Math.min(b.x1, box.x1) - Math.max(b.x0, box.x0)) * Math.max(0, Math.min(b.y1, box.y1) - Math.max(b.y0, box.y0))), 0)
      if (covered > 0.5 * area) continue
      parts.push(box)
    }
  }
  parts.sort((a, b) => a.x0 - b.x0)
  const groups = []
  for (const b of parts) {
    const g = groups[groups.length - 1]
    if (g && b.x0 - g.x1 < 0.8 * line && !skip.some((s) => s.x0 >= g.x1 - 1 && s.x1 <= b.x0 + 1 && s.y0 < g.y1 && s.y1 > g.y0)) {
      g.x0 = Math.min(g.x0, b.x0); g.y0 = Math.min(g.y0, b.y0); g.x1 = Math.max(g.x1, b.x1); g.y1 = Math.max(g.y1, b.y1)
    } else groups.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 })
  }
  return groups.map((g) => ({ ...g, where: g.x1 <= leftOf ? 'left' : Number.isFinite(region.beyond) && g.x0 >= region.beyond ? 'right' : 'inside' }))
}

/**
 * Whether a printed row is struck out by hand (owner: that player does not
 * play): a pen line through the row's words at the height of their middle,
 * where print leaves paper between them. A team's number between two names
 * fills one gap; a pen line fills several in a row, even one that does not
 * cross the whole row, slopes a little or is drawn in a pale or coloured pen
 * (owner, 2026-11-27: a readable row under a line was imported). When the
 * recognition ran the line and the words together (few gaps left), a long
 * stretch of ink along the row's middle tells it: no printed word is that
 * long, and table rules and underlines lie above or below the middle.
 * @param {{x0,y0,x1,y1}[]} words the row's printed words, SV number to date
 */
export function struckThrough (gray, width, height, words, { ink = 170 } = {}) {
  const ws = [...words].filter((w) => w.x1 > w.x0 && w.y1 > w.y0).sort((a, b) => a.x0 - b.x0)
  if (ws.length < 2) return false
  const h = [...ws.map((w) => w.y1 - w.y0)].sort((a, b) => a - b)[ws.length >> 1]
  const midOf = (w) => (w.y0 + w.y1) / 2
  // the row's middle along it (a row slopes in a photo): between two words' middles
  const midAt = (x) => {
    let k = ws.findIndex((w) => (w.x0 + w.x1) / 2 >= x)
    if (k <= 0) return midOf(ws[k < 0 ? ws.length - 1 : 0])
    const a = ws[k - 1]
    const b = ws[k]
    const xa = (a.x0 + a.x1) / 2
    const xb = (b.x0 + b.x1) / 2
    return midOf(a) + ((midOf(b) - midOf(a)) * (x - xa)) / Math.max(1, xb - xa)
  }
  const inkAt = (x, reach) => {
    const m = midAt(x)
    const y0 = Math.max(0, Math.round(m - reach * h))
    const y1 = Math.min(height - 1, Math.round(m + reach * h))
    for (let y = y0; y <= y1; y++) if (gray[y * width + x] < ink) return true
    return false
  }
  // 1. the gaps between the words: crossed when ink lies across (nearly) all of one
  let gaps = 0
  let crossed = 0
  let run = 0
  let longest = 0
  for (let i = 1; i < ws.length; i++) {
    const a = Math.max(0, Math.ceil(ws[i - 1].x1 + 2))
    const b = Math.min(width - 1, Math.floor(ws[i].x0 - 2))
    if (b - a < 0.4 * h) continue
    gaps++
    let inked = 0
    for (let x = a; x <= b; x++) if (inkAt(x, 0.6)) inked++
    if (inked >= 0.85 * (b - a + 1)) { crossed++; run++; longest = Math.max(longest, run) } else run = 0
  }
  if (longest >= 2 || (gaps >= 2 && crossed >= Math.max(2, Math.ceil(0.6 * gaps)))) return true
  // 2. one long stretch of ink along the middle (gaps of a fifth of a line
  // allowed: a pen that skips), longer than any printed word can be
  const x0 = Math.max(0, Math.floor(ws[0].x0))
  const x1 = Math.min(width - 1, Math.ceil(ws[ws.length - 1].x1))
  const need = Math.max(8 * h, 0.4 * (x1 - x0))
  // (across at least one gap between two words: a long name alone is no line)
  const gapIn = (a, b) => ws.some((w, i) => i > 0 && w.x0 - ws[i - 1].x1 >= 0.4 * h && ws[i - 1].x1 >= a && w.x0 <= b)
  let start = -1
  let last = -1
  for (let x = x0; x <= x1; x++) {
    if (!inkAt(x, 0.35)) continue
    if (start < 0 || x - last > 0.2 * h) start = x
    last = x
    if (last - start >= need && gapIn(start, last)) return true
  }
  return false
}

/**
 * Whether a pen line runs across a band of the page where the recognition
 * read nothing (a row it lost: a line through a row can garble it that
 * much): ink along the band's middle (y, a line's height either way) over
 * half its width or more, gaps of a fifth of a line allowed. Text alone
 * never runs that far without a gap.
 * @param {{ x0, x1, y, line }} band page pixels
 */
export function lineAcross (gray, width, height, { x0, x1, y, line }, { ink = 170 } = {}) {
  const a = Math.max(0, Math.floor(x0))
  const b = Math.min(width - 1, Math.ceil(x1))
  const top = Math.max(0, Math.round(y - 0.6 * line))
  const bottom = Math.min(height - 1, Math.round(y + 0.6 * line))
  const need = 0.5 * (b - a)
  let start = -1
  let last = -1
  for (let x = a; x <= b; x++) {
    let dark = false
    for (let yy = top; yy <= bottom && !dark; yy++) dark = gray[yy * width + x] < ink
    if (!dark) continue
    if (start < 0 || x - last > 0.2 * line) start = x
    last = x
    if (last - start >= need) return true
  }
  return false
}

/** A grey page (width x height) turned a quarter clockwise per step: { gray, width, height }. */
export function turnGray (gray, width, height, turns) {
  const n = ((turns % 4) + 4) % 4
  if (!n) return { gray, width, height }
  const w2 = n % 2 ? height : width
  const h2 = n % 2 ? width : height
  const out = new Uint8ClampedArray(gray.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [nx, ny] = n === 1 ? [height - 1 - y, x] : n === 2 ? [width - 1 - x, height - 1 - y] : [y, width - 1 - x]
      out[ny * w2 + nx] = gray[y * width + x]
    }
  }
  return { gray: out, width: w2, height: h2 }
}

/** The default corners: the photo less a 4 % margin. */
export function insetCorners (width, height, margin = 0.04) {
  const mx = width * margin
  const my = height * margin
  return [[mx, my], [width - mx, my], [width - mx, height - my], [mx, height - my]]
}

// ------------------------------------------------------------------ canvas

function canvasOf (width, height) {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

/**
 * The photo (a File or Blob from the camera or a file) on a canvas, its
 * longer side at most maxSide, upright as the camera held it (EXIF).
 */
export async function loadPhoto (file, maxSide = PHOTO_MAX_SIDE) {
  let source = null
  let width = 0
  let height = 0
  if (typeof createImageBitmap === 'function') {
    try {
      source = await createImageBitmap(file, { imageOrientation: 'from-image' })
      width = source.width
      height = source.height
    } catch { source = null }
  }
  if (!source) {
    const url = URL.createObjectURL(file)
    try {
      source = await new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(Object.assign(new Error('The photo could not be opened'), { code: 'photo-unreadable' }))
        img.src = url
      })
      width = source.naturalWidth
      height = source.naturalHeight
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  if (!width || !height) throw Object.assign(new Error('The photo could not be opened'), { code: 'photo-unreadable' })
  const f = Math.min(1, maxSide / Math.max(width, height))
  const canvas = canvasOf(Math.round(width * f), Math.round(height * f))
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height)
  source.close?.()
  return canvas
}

/** The page's corners in the photo (canvas pixels): the guess, else the inset default. */
export function guessCorners (canvas) {
  const f = Math.min(1, GUESS_SIDE / Math.max(canvas.width, canvas.height))
  const w = Math.max(1, Math.round(canvas.width * f))
  const h = Math.max(1, Math.round(canvas.height * f))
  const small = canvasOf(w, h)
  const ctx = small.getContext('2d')
  ctx.drawImage(canvas, 0, 0, w, h)
  const gray = toGray(ctx.getImageData(0, 0, w, h).data, w, h)
  const found = cornersFromGray(gray, w, h)
  if (!found) return insetCorners(canvas.width, canvas.height)
  const corners = orderCorners(found.map(([x, y]) => [
    Math.min(canvas.width, Math.max(0, x === w - 1 ? canvas.width : (x + 0.5) / f)),
    Math.min(canvas.height, Math.max(0, y === h - 1 ? canvas.height : (y + 0.5) / f))
  ]))
  // a page is a convex four-sided shape of some size; anything else (a
  // bright sky, a lamp) is no guess: the default corners, for the scorer to drag
  return plausiblePage(corners, canvas.width, canvas.height) ? corners : insetCorners(canvas.width, canvas.height)
}

/** Whether [tl, tr, br, bl] can be a page: convex, turning one way, at least a fifth of the photo. */
export function plausiblePage (corners, width, height) {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [corners[i], corners[(i + 1) % 4], corners[(i + 2) % 4]]
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (Math.abs(cross) < 1e-6) return false
    if (sign && Math.sign(cross) !== sign) return false
    sign = Math.sign(cross)
  }
  let area = 0
  for (let i = 0; i < 4; i++) {
    const [a, b] = [corners[i], corners[(i + 1) % 4]]
    area += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(area) / 2 >= 0.2 * width * height
}

/** The flat, even, grey page inside `corners` of the photo canvas, as a new canvas. */
export function scanPage (canvas, corners, { maxSide = PAGE_MAX_SIDE } = {}) {
  const { width, height } = pageSize(corners, maxSide)
  const src = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
  const even = stretchContrast(evenLight(warpGray(src.data, canvas.width, canvas.height, corners, width, height), width, height))
  // the page before its rules go: a pen line through a row (ocr.js
  // struckThrough) may be straight enough to be taken for one
  const beforeRules = even.slice()
  const gray = removeRules(even, width, height)
  const out = canvasOf(width, height)
  out.beforeRules = beforeRules
  // its grey pixels kept beside it: what the recognition is handed (ocr.js pgmOf), no read back
  out.gray = gray
  const ctx = out.getContext('2d')
  const img = ctx.createImageData(width, height)
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    img.data[j] = img.data[j + 1] = img.data[j + 2] = gray[i]
    img.data[j + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return out
}

/** A canvas as a PNG Blob (lossless: the recognition reads it, nobody downloads it). */
export function canvasBlob (canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The page could not be made into an image'))), type, quality)
  })
}
