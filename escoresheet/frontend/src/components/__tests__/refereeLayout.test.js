import { describe, it, expect } from 'vitest'
import {
  REFEREE_LAYOUT, isWideLayout, columnWidth, sidePanelWidth, courtBoxInSlot, courtDiscRoom, screenFit,
  portraitCourtBox, PORTRAIT_COURT
} from '../referee/refereeLayout.js'
import { RECEPTION, layoutReception, formationPointPx, pointToFormation, boxSeparation } from '../referee/receptionLayout.js'
import { DISC, discMetrics, discFitProblems, discCapPx } from '../referee/discSizing.js'

describe('referee page width and arrangement', () => {
  it('grows the page column with the viewport up to 1400 px (it was capped at 800)', () => {
    expect(columnWidth(360)).toBe(360)
    expect(columnWidth(800)).toBe(800)
    expect(columnWidth(1280)).toBe(1280)
    expect(columnWidth(1366)).toBe(1366)
    expect(columnWidth(1920)).toBe(REFEREE_LAYOUT.maxWidth)
    expect(REFEREE_LAYOUT.maxWidth).toBe(1400)
  })

  it('puts the side panels beside the court on landscape tablets only', () => {
    // landscape tablets, laptops, desktops
    for (const [w, h] of [[1280, 800], [1280, 720], [1024, 768], [1180, 820], [1366, 1024], [962, 601], [1920, 1200], [1340, 800]]) {
      expect(isWideLayout(w, h), `${w}x${h}`).toBe(true)
    }
    // portrait tablets, phones, square-ish windows
    for (const [w, h] of [[800, 1280], [768, 1024], [820, 1180], [601, 962], [390, 844], [360, 740], [800, 1340], [700, 680], [600, 400]]) {
      expect(isWideLayout(w, h), `${w}x${h}`).toBe(false)
    }
  })

  it('side panels scale with the viewport between 128 and 168 px (room for two sanction chips)', () => {
    expect(sidePanelWidth(640)).toBe(REFEREE_LAYOUT.sideMinPx)
    expect(sidePanelWidth(1280)).toBeCloseTo(140.8)
    expect(sidePanelWidth(962)).toBe(REFEREE_LAYOUT.sideMinPx)
    expect(sidePanelWidth(1920)).toBe(REFEREE_LAYOUT.sideMaxPx)
  })

  it('keeps the court in proportion: never wider than 2.2 times its height', () => {
    // a wide, short slot: the height decides
    const flat = courtBoxInSlot(1200, 300)
    expect(flat.height).toBeCloseTo(294)
    expect(flat.width).toBeCloseTo(294 * 2.2)
    // a portrait slot: the width decides, as before
    const tall = courtBoxInSlot(800, 470)
    expect(tall.width).toBeCloseTo(784)
    expect(tall.height).toBeCloseTo(460.6)
  })

  it('discs, numbers, marks and the ball still fit on any court box up to the 1400 px column', () => {
    for (let courtWidth = 340; courtWidth <= 1380; courtWidth += 40) {
      for (let courtHeight = 150; courtHeight <= 800; courtHeight += 25) {
        const box = courtBoxInSlot(courtWidth / REFEREE_LAYOUT.courtFill, courtHeight / REFEREE_LAYOUT.courtFill)
        for (const capPx of [40, 70, 93, 139, 200]) {
          const problems = discFitProblems({ courtWidth: box.width, courtHeight: box.height, viewportWidth: Math.max(courtWidth + 8, 1024), capPx })
          expect(problems, `court ${Math.round(box.width)}x${Math.round(box.height)} cap ${capPx}`).toEqual([])
        }
      }
    }
  })

  it('the larger landscape court makes the discs larger on a tablet than the 800 px page did', () => {
    // 1280 x 800: old court 784 x 272 (disc 70); the wide layout's court slot
    // is about 1000 x 500 (header, score rows and the 40 px footer above and below)
    const cap = discCapPx((v) => 800 * v / 100)
    const before = discMetrics({ courtWidth: 784, courtHeight: 272, capPx: cap }).disc
    const box = courtBoxInSlot(1280 - 2 * sidePanelWidth(1280), 500)
    const after = discMetrics({ courtWidth: box.width, courtHeight: box.height, capPx: cap }).disc
    expect(after).toBeGreaterThan(before + 15)
    expect(discFitProblems({ courtWidth: box.width, courtHeight: box.height, viewportWidth: 1280, capPx: cap })).toEqual([])
  })
})

describe('"screen too small" overlay', () => {
  it('shows below 357 px wide, whatever the court', () => {
    expect(screenFit({ viewportWidth: 356, courtWidth: 340, courtHeight: 240 })).toMatchObject({ fits: false, reason: 'width' })
    expect(screenFit({ viewportWidth: 356 }).fits).toBe(false)
    expect(screenFit({ viewportWidth: 357, courtWidth: 345, courtHeight: 240 }).fits).toBe(true)
  })

  it('no longer shows because a screen is under 650 px high when the court fits (962 x 601 tablet)', () => {
    // 962 x 601 (10" Android at DPR 2): the court it gets, old and new layout
    expect(screenFit({ viewportWidth: 962, courtWidth: 784, courtHeight: 194 }).fits).toBe(true)
    expect(screenFit({ viewportWidth: 962, courtWidth: 700, courtHeight: 300 }).fits).toBe(true)
    // 1280 x 600 laptop window
    expect(screenFit({ viewportWidth: 1280, courtWidth: 900, courtHeight: 290 }).fits).toBe(true)
  })

  it('shows when the court cannot hold a disc of the minimum size', () => {
    // a phone on its side with the browser bars: 844 x 340, court ~120 px high
    const r = screenFit({ viewportWidth: 844, courtWidth: 264, courtHeight: 120 })
    expect(r).toMatchObject({ fits: false, reason: 'court' })
    expect(r.disc).toBeLessThan(DISC.minPx)
    // a court too narrow for the front column
    expect(screenFit({ viewportWidth: 400, courtWidth: 220, courtHeight: 300 }).fits).toBe(false)
  })

  it('the threshold is the disc floor: just below it shows, at it does not', () => {
    const h = (DISC.minPx / DISC.heightCqh) * 100 // court height that gives exactly minPx
    expect(courtDiscRoom(2000, h)).toBeCloseTo(DISC.minPx)
    expect(screenFit({ viewportWidth: 900, courtWidth: 800, courtHeight: h }).fits).toBe(true)
    expect(screenFit({ viewportWidth: 900, courtWidth: 800, courtHeight: h - 1 }).fits).toBe(false)
  })

  it('before the court is measured only the width rule applies', () => {
    expect(screenFit({ viewportWidth: 900, courtWidth: null, courtHeight: null }).fits).toBe(true)
    expect(screenFit({ viewportWidth: 900, courtWidth: 0, courtHeight: 0 }).fits).toBe(true)
  })
})

// Reception formations as in Referee.jsx getReceptionFormation
const FORMATIONS = {
  1: { I: { top: 88, left: 88 }, II: { top: 70, left: 80 }, III: { top: 28, left: 50 }, IV: { top: 28, left: 15 }, V: { top: 80, left: 15 }, VI: { top: 78, left: 50 } },
  2: { I: { top: 70, left: 85 }, II: { top: 12, left: 88 }, III: { top: 28, left: 50 }, IV: { top: 70, left: 15 }, V: { top: 88, left: 40 }, VI: { top: 70, left: 50 } },
  3: { I: { top: 70, left: 82 }, II: { top: 12, left: 82 }, III: { top: 13, left: 50 }, IV: { top: 67, left: 15 }, V: { top: 70, left: 45 }, VI: { top: 88, left: 60 } },
  4: { I: { top: 88, left: 88 }, II: { top: 70, left: 35 }, III: { top: 40, left: 25 }, IV: { top: 12, left: 15 }, V: { top: 70, left: 55 }, VI: { top: 70, left: 75 } },
  5: { I: { top: 75, left: 82 }, II: { top: 12, left: 85 }, III: { top: 75, left: 35 }, IV: { top: 12, left: 15 }, V: { top: 42, left: 33 }, VI: { top: 75, left: 58 } },
  6: { I: { top: 78, left: 82 }, II: { top: 25, left: 82 }, III: { top: 12, left: 50 }, IV: { top: 72, left: 18 }, V: { top: 78, left: 44 }, VI: { top: 42, left: 59 } }
}

const assertNoOverlap = (res, width, height, label) => {
  const pts = Object.entries(res.points)
  for (let i = 0; i < pts.length; i++) {
    const [pa, a] = pts[i]
    expect(a.x - res.size / 2, `${label} ${pa} left`).toBeGreaterThanOrEqual(-0.01)
    expect(a.x + res.size / 2, `${label} ${pa} right`).toBeLessThanOrEqual(width + 0.01)
    expect(a.y - res.size / 2, `${label} ${pa} top`).toBeGreaterThanOrEqual(-0.01)
    expect(a.y + res.size / 2, `${label} ${pa} bottom`).toBeLessThanOrEqual(height + 0.01)
    for (let j = i + 1; j < pts.length; j++) {
      const [pb, b] = pts[j]
      // square boxes clear (the marks sit in the corners), so the circles are too
      expect(boxSeparation(a, b), `${label} ${pa}-${pb}`).toBeGreaterThanOrEqual(res.size)
    }
  }
}

describe('reception formation layout', () => {
  // court boxes (content) from phone to the 1400 px column, and the disc the court gives
  const COURTS = [[353, 249], [382, 290], [589, 336], [784, 461], [784, 272], [1000, 480], [1046, 476], [1160, 777], [1250, 560], [1370, 620]]
  const caps = [40, 70, 93, 139, 200]

  it('no two discs overlap and none leaves its half, for every formation, court and side', () => {
    for (const [cw, ch] of COURTS) {
      for (const capPx of caps) {
        const disc = discMetrics({ courtWidth: cw, courtHeight: ch, capPx }).disc
        for (const [setter, formation] of Object.entries(FORMATIONS)) {
          for (const side of ['left', 'right']) {
            const res = layoutReception({ formation, side, width: cw / 2, height: ch, disc })
            expect(res.scale).toBeLessThanOrEqual(RECEPTION.maxScale)
            assertNoOverlap(res, cw / 2, ch, `${cw}x${ch} cap ${capPx} P${setter} ${side}`)
          }
        }
      }
    }
  })

  it('1920 x 1200: disc I no longer sits on disc II (P1, the case from the tablet check)', () => {
    // old: 784 x 429 court, 111 px discs at 80 % = 88 px, I and II 78 px apart
    const disc = 111
    const res = layoutReception({ formation: FORMATIONS[1], side: 'right', width: 392, height: 429, disc })
    const { I, II } = res.points
    expect(boxSeparation(I, II)).toBeGreaterThanOrEqual(res.size)
    expect(res.scale).toBeLessThan(RECEPTION.maxScale)
    expect(res.scale).toBeGreaterThanOrEqual(RECEPTION.minScale)
  })

  it('keeps the 80 % size and the formation spots when there is room', () => {
    const res = layoutReception({ formation: FORMATIONS[3], side: 'left', width: 400, height: 460, disc: 60 })
    expect(res.scale).toBe(RECEPTION.maxScale)
    const III = formationPointPx(FORMATIONS[3].III, 'left', 400, 460)
    expect(res.points.III.x).toBeCloseTo(III.x)
    expect(res.points.III.y).toBeCloseTo(III.y)
  })

  it('pushes apart positions dragged onto the same spot', () => {
    const stacked = Object.fromEntries(['I', 'II', 'III', 'IV', 'V', 'VI'].map((p) => [p, { top: 50, left: 50 }]))
    const res = layoutReception({ formation: stacked, side: 'right', width: 392, height: 429, disc: 93 })
    expect(res.scale).toBe(RECEPTION.minScale)
    assertNoOverlap(res, 392, 429, 'stacked')
  })

  it('a dropped point maps back to the spot it was dropped on (both halves)', () => {
    for (const side of ['left', 'right']) {
      const f = pointToFormation({ x: 120, y: 300 }, side, 400, 460)
      const p = formationPointPx(f, side, 400, 460)
      expect(p.x).toBeCloseTo(120)
      expect(p.y).toBeCloseTo(300)
    }
  })
})

// Owner 2026-11-09: the referee tablet is held upright. The court takes the
// column's width and grows in height down to 1.3 : 1; the discs grow with it
// (the cap follows the width); the strip under it gets the rest.
describe('referee page upright (portrait)', () => {
  it('the court takes the width and as much height as 1.3 : 1 allows, never wider than 2.2 : 1', () => {
    // 820 x 1180 tablet: a tall slot, the width decides
    const tab = portraitCourtBox(820, 900)
    expect(tab.width).toBeCloseTo(803.6)
    expect(tab.height).toBeCloseTo(803.6 / 1.3)
    // a short slot (phone, browser bars): the height decides, the width follows 2.2 : 1
    const short = portraitCourtBox(390, 150)
    expect(short.height).toBeCloseTo(147)
    expect(short.width).toBeCloseTo(147 * 2.2)
    // the CSS says the same
    expect(PORTRAIT_COURT.width).toBe('min(98cqw, calc(98cqh * 2.2))')
    expect(PORTRAIT_COURT.height).toBe('min(98cqh, calc(98cqw / 1.3))')
    expect(PORTRAIT_COURT.sectionMaxHeight).toBe(`calc(min(100vw, 1400px) / 1.3 + ${REFEREE_LAYOUT.portraitButtonRowPx}px)`)
  })

  it('discs fill the upright court (about 116-124 px on a portrait tablet, 70-95 before)', () => {
    for (const [w, h] of [[820, 1180], [768, 1024], [800, 1280]]) {
      const vmin = (v) => Math.min(w, h) * v / 100
      const box = portraitCourtBox(w, h * 0.6)
      const portrait = discMetrics({ courtWidth: box.width, courtHeight: box.height, capPx: discCapPx(vmin, { portrait: true }) })
      const before = discMetrics({ courtWidth: box.width, courtHeight: box.height, capPx: discCapPx(vmin) })
      expect(portrait.disc, `${w}x${h}`).toBeGreaterThan(before.disc + 15)
      expect(portrait.disc).toBeCloseTo(box.width * DISC.widthCqw / 100)
    }
  })

  it('discs, numbers, marks and the ball fit every upright court box from a 360 px phone to a 1024 px tablet', () => {
    for (let w = 360; w <= 1024; w += 24) {
      for (let slotH = 180; slotH <= 1100; slotH += 40) {
        const box = portraitCourtBox(w, slotH)
        const vmin = (v) => w * v / 100
        const problems = discFitProblems({ courtWidth: box.width, courtHeight: box.height, viewportWidth: w, capPx: discCapPx(vmin, { portrait: true }) })
        expect(problems, `${w} wide, slot ${slotH}: court ${Math.round(box.width)}x${Math.round(box.height)}`).toEqual([])
      }
    }
  })

  it('the serve ball keeps a clear gap from the server\'s disc (owner 2026-11-09)', () => {
    expect(DISC.ballGap).toBeGreaterThanOrEqual(0.1)
    const m = discMetrics({ courtWidth: 804, courtHeight: 618, capPx: 140 })
    expect(m.ballGap).toBeGreaterThanOrEqual(12)
    expect(m.ball).toBeGreaterThan(30)
  })
})
