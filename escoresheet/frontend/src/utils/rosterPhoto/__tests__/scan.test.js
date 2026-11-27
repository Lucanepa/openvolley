import { describe, it, expect } from 'vitest'
import {
  cornersFromGray, evenLight, homography, insetCorners, orderCorners, otsuThreshold, pageSize, plausiblePage, project,
  removeRules, ringInRegion, ringScore, rotateCorners, stretchContrast, warpGray, struckThrough, handInk, turnGray,
  columnLine, marginBand
} from '../scan'

// a grey page (255) of w x h with draw(x, y) -> value | undefined
function page (w, h, draw = () => undefined) {
  const g = new Uint8ClampedArray(w * h).fill(255)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = draw(x, y); if (v !== undefined) g[y * w + x] = v }
  return g
}
const at = (g, w, x, y) => g[y * w + x]

describe('corners and the homography', () => {
  it('orderCorners: tl, tr, br, bl whatever the order; rotateCorners turns the page a quarter', () => {
    const c = orderCorners([[90, 95], [10, 8], [100, 5], [5, 99]])
    expect(c).toEqual([[10, 8], [100, 5], [90, 95], [5, 99]])
    expect(rotateCorners(c, 1)).toEqual([[5, 99], [10, 8], [100, 5], [90, 95]])
    expect(rotateCorners(c, 4)).toEqual(c)
  })

  it('homography takes each corner to its target, and points between them consistently', () => {
    const src = [[0, 0], [99, 0], [99, 199], [0, 199]]
    const dst = [[30, 20], [180, 40], [170, 300], [10, 280]]
    const h = homography(src, dst)
    for (let i = 0; i < 4; i++) {
      const [x, y] = project(h, ...src[i])
      expect(x).toBeCloseTo(dst[i][0], 6)
      expect(y).toBeCloseTo(dst[i][1], 6)
    }
    expect(homography(src, [[0, 0], [1, 1], [2, 2], [3, 3]])).toBeNull()
  })

  it('pageSize: the longer edges, at most maxSide, a small page enlarged up to twice', () => {
    expect(pageSize([[0, 0], [1000, 0], [1000, 1414], [0, 1414]], 2200)).toEqual({ width: 1556, height: 2200 })
    expect(pageSize([[0, 0], [500, 0], [500, 700], [0, 700]], 2200)).toEqual({ width: 1000, height: 1400 })
  })

  it('warpGray undoes a skew: a dark square in a skewed page comes out where it is on the page', () => {
    // a 60 x 80 "page" drawn into a 120 x 120 photo through a skew
    const pageCorners = [[20, 10], [100, 25], [95, 110], [10, 100]]
    const toPhoto = homography([[0, 0], [59, 0], [59, 79], [0, 79]], pageCorners)
    const rgba = new Uint8ClampedArray(120 * 120 * 4).fill(40) // a dark table
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 60; x++) {
        const [px, py] = project(toPhoto, x, y)
        const ink = x >= 20 && x < 40 && y >= 30 && y < 50
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const j = ((Math.round(py) + dy) * 120 + Math.round(px) + dx) * 4
          rgba[j] = rgba[j + 1] = rgba[j + 2] = ink ? 0 : 250
        }
      }
    }
    const flat = warpGray(rgba, 120, 120, pageCorners, 60, 80)
    expect(at(flat, 60, 30, 40)).toBeLessThan(60) // the square
    expect(at(flat, 60, 8, 8)).toBeGreaterThan(200) // paper
    expect(at(flat, 60, 52, 70)).toBeGreaterThan(200)
  })

  it('cornersFromGray finds the bright page on a dark table; a photo of only the page gives its edges', () => {
    const w = 80
    const h = 60
    const g = page(w, h, (x, y) => (x >= 15 && x < 65 && y >= 10 && y < 52 ? 230 : 50))
    const c = cornersFromGray(g, w, h)
    expect(c[0]).toEqual([15, 10])
    expect(c[2]).toEqual([64, 51])
    expect(cornersFromGray(page(w, h, () => 230), w, h)).toEqual([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
    expect(cornersFromGray(page(w, h, (x) => (x < 8 ? 230 : 40)), w, h)).toBeNull()
    expect(insetCorners(100, 50)).toEqual([[4, 2], [96, 2], [96, 48], [4, 48]])
  })

  // (real photos, 2026-11-26: the region's extreme points cut the table)
  const close = (p, q, d = 3) => Math.abs(p[0] - q[0]) <= d && Math.abs(p[1] - q[1]) <= d
  const tilted = [[22, 12], [138, 18], [134, 112], [18, 106]]
  const insideTilted = (x, y) => {
    let sign = 0
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = tilted[i]
      const [bx, by] = tilted[(i + 1) % 4]
      const c = Math.sign((bx - ax) * (y - ay) - (by - ay) * (x - ax))
      if (sign && c && c !== sign) return false
      sign = c || sign
    }
    return true
  }
  const onTable = (extra) => page(160, 120, (x, y) => (extra(x, y) || insideTilted(x, y) ? 230 : 50))

  it('cornersFromGray: a corner a shadow takes away is where the two long edges meet', () => {
    // the phone's shadow over the bottom left: that corner is dark
    const g = onTable(() => false).map((v, i) => (i % 160 < 60 && Math.floor(i / 160) > 70 && (i % 160) + 110 - Math.floor(i / 160) < 70 ? 50 : v))
    const c = cornersFromGray(g, 160, 120)
    tilted.forEach((p, i) => expect(close(c[i], p), `corner ${i}: ${c[i]}`).toBe(true))
  })

  it('cornersFromGray: something bright touching the page (a hand, a second sheet) does not pull a corner', () => {
    // a bright blob joined to the page at the bottom left, out to the photo's edge
    const g = onTable((x, y) => y > 96 && y < 118 && x < 40)
    const c = cornersFromGray(g, 160, 120)
    tilted.forEach((p, i) => expect(close(c[i], p), `corner ${i}: ${c[i]}`).toBe(true))
  })

  it('plausiblePage: a convex shape of a fifth of the photo or more; a triangle or a sliver is none', () => {
    expect(plausiblePage([[10, 10], [90, 12], [88, 95], [8, 90]], 100, 100)).toBe(true)
    // two corners on one spot (a bright sky): a triangle
    expect(plausiblePage([[0, 0], [100, 0], [30, 100], [30, 100]], 100, 100)).toBe(false)
    expect(plausiblePage([[0, 0], [100, 0], [100, 10], [0, 10]], 100, 100)).toBe(false)
    // crossed (a bow tie)
    expect(plausiblePage([[0, 0], [100, 100], [100, 0], [0, 100]], 100, 100)).toBe(false)
  })
})

describe('light, contrast and rules', () => {
  it('evenLight makes a shadowed half of the page as white as the lit one; ink stays dark', () => {
    const w = 64
    const h = 64
    // paper 120 on the left (shadow), 240 on the right; ink at a third of the paper's brightness
    const g = page(w, h, (x, y) => {
      const paper = x < 32 ? 120 : 240
      return (x % 16 === 8 && y % 16 < 8) ? paper / 3 : paper
    })
    const even = evenLight(g, w, h, 8)
    expect(Math.abs(at(even, w, 4, 20) - at(even, w, 60, 20))).toBeLessThan(25)
    expect(at(even, w, 8, 2)).toBeLessThan(120)
    expect(at(even, w, 56, 2)).toBeLessThan(120)
  })

  it('stretchContrast: the darkest 1 % black, the paper white; otsuThreshold splits two levels', () => {
    const g = page(100, 10, (x) => (x < 20 ? 90 : 200))
    stretchContrast(g)
    expect(g[0]).toBe(0)
    expect(g[50]).toBe(255)
    const t = otsuThreshold(page(100, 10, (x) => (x < 30 ? 40 : 210)))
    expect(t).toBeGreaterThanOrEqual(40)
    expect(t).toBeLessThan(210)
  })

  it('removeRules takes out a table\'s thin rules and keeps letters, even bold ones run together', () => {
    const w = 300
    const h = 200
    const g = page(w, h, (x, y) => {
      if (y === 50 || y === 51) return 30 // a rule across
      if (x === 150) return 30 // a rule down
      // a bold word whose letters ran together: 120 px wide, 12 px high
      if (y >= 100 && y < 112 && x >= 20 && x < 140) return (x % 10 < 7 || y === 106) ? 20 : 255
      return undefined
    })
    removeRules(g, w, h)
    expect(at(g, w, 10, 50)).toBe(255)
    expect(at(g, w, 150, 20)).toBe(255)
    // the word: its middle row (one long run, ink above and below) is kept
    expect(at(g, w, 25, 106)).toBe(20)
    expect(at(g, w, 25, 103)).toBe(20)
  })
})

describe('circles (a circled number: the captain)', () => {
  // a ring of radius r round (cx, cy), a "digit" block inside
  const circled = (w, h, cx, cy, r, digit = true) => page(w, h, (x, y) => {
    const d = Math.hypot(x - cx, y - cy)
    if (Math.abs(d - r) < 1.6) return 20
    if (digit && Math.abs(x - cx) <= 4 && Math.abs(y - cy) <= 7) return 20
    return undefined
  })

  it('ringScore: high for a ring round a box, low for the box alone or with text beside it', () => {
    const box = { x0: 46, y0: 43, x1: 54, y1: 57 }
    expect(ringScore(circled(100, 100, 50, 50, 20), 100, 100, box)).toBeGreaterThanOrEqual(0.8)
    expect(ringScore(circled(100, 100, 50, 50, 20, true).map((v, i) => (Math.hypot(i % 100 - 50, Math.floor(i / 100) - 50) > 15 ? 255 : v)), 100, 100, box)).toBe(0)
    const beside = page(100, 100, (x, y) => (Math.abs(x - 50) <= 4 && Math.abs(y - 50) <= 7) || (x > 62 && x < 95 && y > 44 && y < 56) ? 20 : undefined)
    expect(ringScore(beside, 100, 100, box)).toBe(0)
  })

  it('ringInRegion finds a circle round a number; a big 0 alone, a filled blob or nothing is none', () => {
    const region = { x0: 0, y0: 0, x1: 100, y1: 100 }
    const found = ringInRegion(circled(100, 100, 50, 50, 22), 100, 100, region, 16)
    expect(found).not.toBeNull()
    expect(found.inner).toEqual({ x0: 46, y0: 43, x1: 54, y1: 57 })
    expect(ringInRegion(circled(100, 100, 50, 50, 22, false), 100, 100, region, 16)).toBeNull()
    const blob = page(100, 100, (x, y) => (Math.hypot(x - 50, y - 50) < 22 ? 20 : undefined))
    expect(ringInRegion(blob, 100, 100, region, 16)).toBeNull()
    expect(ringInRegion(page(100, 100), 100, 100, region, 16)).toBeNull()
    // a ring far smaller than a line of print is a letter's loop
    expect(ringInRegion(circled(100, 100, 50, 50, 6, false), 100, 100, region, 16)).toBeNull()
  })
})

// (real photos, 2026-11-26) a row's words as boxes on a 400 x 60 page
const rowWords = [{ x0: 20, y0: 20, x1: 80, y1: 40 }, { x0: 110, y0: 20, x1: 160, y1: 40 }, { x0: 200, y0: 20, x1: 270, y1: 40 }, { x0: 300, y0: 20, x1: 380, y1: 40 }]
const inWords = (x, y) => rowWords.some((w) => x >= w.x0 && x < w.x1 && y >= w.y0 && y < w.y1 && (x + y) % 3 === 0)

describe('a row struck out, the team\'s handwriting, a page turned', () => {
  it('struckThrough: a pen line through the row is; a number written between two names is not', () => {
    const struck = page(400, 60, (x, y) => (inWords(x, y) || (Math.abs(y - 30 - (x - 20) * 0.01) < 1.5 && x >= 15 && x <= 385) ? 20 : undefined))
    expect(struckThrough(struck, 400, 60, rowWords)).toBe(true)
    const marked = page(400, 60, (x, y) => (inWords(x, y) || (x >= 170 && x <= 190 && y >= 18 && y <= 44 && x % 4 === 0) ? 20 : undefined))
    expect(struckThrough(marked, 400, 60, rowWords)).toBe(false)
    expect(struckThrough(page(400, 60, (x, y) => (inWords(x, y) ? 20 : undefined)), 400, 60, rowWords)).toBe(false)
  })

  it('struckThrough: a readable row under a line counts in a pale pen, a wavy line, a line over part of the row (owner, 2026-11-27)', () => {
    const row = (line) => page(400, 60, (x, y) => (inWords(x, y) ? 20 : line(x, y)))
    // a pale (blue) ballpoint, grey 150 on the photo
    expect(struckThrough(row((x, y) => (Math.abs(y - 30) < 1.5 && x >= 15 && x <= 385 ? 150 : undefined)), 400, 60, rowWords)).toBe(true)
    // drawn by hand: wavy and sloping, a little off the middle
    expect(struckThrough(row((x, y) => (Math.abs(y - 27 - 3 * Math.sin(x / 25) - (x - 20) * 0.02) < 1.5 && x >= 15 && x <= 385 ? 40 : undefined)), 400, 60, rowWords)).toBe(true)
    // through the names only, not the SV number or the date
    expect(struckThrough(row((x, y) => (Math.abs(y - 31) < 1.5 && x >= 100 && x <= 290 ? 40 : undefined)), 400, 60, rowWords)).toBe(true)
    // the recognition ran the line into the words: two words left, one long stretch of ink
    const merged = [{ x0: 20, y0: 20, x1: 80, y1: 40 }, { x0: 110, y0: 20, x1: 380, y1: 40 }]
    expect(struckThrough(row((x, y) => (Math.abs(y - 30) < 1.5 && x >= 15 && x <= 385 ? 40 : undefined)), 400, 60, merged)).toBe(true)
  })

  it('struckThrough: underlines, table rules and marks like L1 or K are no strike', () => {
    const row = (line) => page(400, 60, (x, y) => (inWords(x, y) ? 20 : line(x, y)))
    // a line under the row (an underline) and the rules between the rows
    expect(struckThrough(row((x, y) => ((y === 43 || y === 3 || y === 57) && x >= 0 ? 30 : undefined)), 400, 60, rowWords)).toBe(false)
    // "L1" and "K" written in two gaps, a short dash in the margin
    const marks = (x, y) => ((x >= 88 && x <= 102 && y >= 22 && y <= 38 && (x === 88 || y === 38 || x === 100)) || (x >= 280 && x <= 292 && y >= 22 && y <= 38 && (x === 280 || Math.abs(y - 30 - (x - 280)) < 1 || Math.abs(y - 30 + (x - 280)) < 1)) || (x >= 2 && x <= 14 && y === 30) ? 30 : undefined)
    expect(struckThrough(row(marks), 400, 60, rowWords)).toBe(false)
    // one long name alone is no line
    const longName = [{ x0: 20, y0: 20, x1: 80, y1: 40 }, { x0: 100, y0: 20, x1: 330, y1: 40 }, { x0: 340, y0: 20, x1: 380, y1: 40 }]
    expect(struckThrough(page(400, 60, (x, y) => (longName.some((w) => x >= w.x0 && x < w.x1 && y >= w.y0 && y < w.y1 && (x + y) % 3 === 0) ? 20 : undefined)), 400, 60, longName)).toBe(false)
  })

  it('handInk: ink left of the SV number and between the names, none of the printed words, a pale pen too', () => {
    // a number in the margin (pale grey), a mark between the 2nd and 3rd word, a speck
    const g = page(400, 60, (x, y) => {
      if (inWords(x, y)) return 20
      if (x >= 2 && x <= 12 && y >= 16 && y <= 44 && (x === 4 || y === 16 || y === 44)) return 170
      if (x >= 172 && x <= 186 && y >= 22 && y <= 40 && (x === 174 || y === 40)) return 40
      if (x === 290 && y === 30) return 20
      return undefined
    })
    const groups = handInk(g, 400, 60, { left: 20, x0: -100, x1: 400, y: 30, line: 20, skip: rowWords, beyond: null }, { leftOf: 20 })
    expect(groups.map((b) => [b.where, b.x0 <= 4 && b.x1 >= 12 ? 'margin' : b.x0 >= 172 && b.x1 <= 188 ? 'between' : 'other'])).toEqual([['left', 'margin'], ['inside', 'between']])
  })

  it('turnGray: a quarter turn clockwise, four make the page again', () => {
    const g = new Uint8ClampedArray([1, 2, 3, 4, 5, 6]) // 3 x 2
    const q = turnGray(g, 3, 2, 1)
    expect([q.width, q.height, [...q.gray]]).toEqual([2, 3, [4, 1, 5, 2, 6, 3]])
    let back = { gray: g, width: 3, height: 2 }
    for (let i = 0; i < 4; i++) back = turnGray(back.gray, back.width, back.height, 1)
    expect([...back.gray]).toEqual([...g])
  })
})

describe('the left margin as one crop (the handwriting reader)', () => {
  it('columnLine: the SV column down a sloping page, a row whose number lost or gained a digit left out', () => {
    // x = 100 + 0.05 y, one row 40 px right of it (its first digit lost), one 35 px left (a digit written into it)
    const rows = [0, 1, 2, 3, 4, 5, 6].map((k) => ({ y: 200 + 60 * k, left: 100 + 0.05 * (200 + 60 * k) }))
    rows[2].left += 40
    rows[5].left -= 35
    const col = columnLine(rows)
    expect(col(200)).toBeCloseTo(110, 5)
    expect(col(1000)).toBeCloseTo(150, 5)
    expect(columnLine(rows.slice(0, 2))).toBeNull()
    expect(columnLine([{ y: 5, left: 3 }, { y: null, left: 1 }, { y: 9, left: 2 }])).toBeNull()
  })

  it('marginBand: the ink of the row in the margin, with a quarter of its height round it; nothing of the rows above and under, no speck, no printed digit at the edge', () => {
    // a row at y = 100, a line 20 px high; the band from x 0 to 120
    const g = page(200, 200, (x, y) => {
      if (x >= 30 && x <= 40 && y >= 90 && y <= 110) return 60 // the number (on the row)
      if (x >= 50 && x <= 56 && y >= 92 && y <= 104) return 150 // a pale C beside it
      if (x >= 30 && x <= 40 && y >= 66 && y <= 72) return 30 // the row above's number (its middle 31 px up)
      if (x === 80 && y === 100) return 20 // a speck
      if (x >= 112 && x <= 119 && y >= 92 && y <= 108) return 20 // the SV number's first digit, at the band's edge
      return undefined
    })
    const box = marginBand(g, 200, 200, { x0: 0, x1: 120, y: 100, line: 20 })
    // the number and the C: x 30..56, y 90..110 (21 px high: 5 px round it)
    expect(box).toEqual({ x0: 25, y0: 85, w: 37, h: 31 })
    expect(marginBand(page(200, 200), 200, 200, { x0: 0, x1: 120, y: 100, line: 20 })).toBeNull()
    expect(marginBand(g, 200, 200, { x0: 50, x1: 52, y: 100, line: 20 })).toBeNull()
  })

  it('marginBand stays inside the band and the page', () => {
    const g = page(60, 60, (x, y) => (x >= 1 && x <= 8 && y >= 22 && y <= 38 ? 0 : undefined))
    expect(marginBand(g, 60, 60, { x0: -30, x1: 40, y: 30, line: 20 })).toEqual({ x0: 0, y0: 18, w: 13, h: 25 })
  })
})
