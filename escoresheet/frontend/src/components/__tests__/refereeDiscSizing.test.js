import { describe, it, expect } from 'vitest'
import { DISC, discCssVars, discMetrics, discFitProblems, discCapPx } from '../referee/discSizing.js'

// Court boxes the referee view produces (measured in Chromium, see the PR):
// the page is at most 800 px wide, so the court is at most ~784 px wide; its
// height is what is left under the header, scores and above the TO/SUB row.
const MEASURED = [
  // [viewport w, viewport h, court w, court h]
  [800, 1280, 784, 461], [1280, 800, 784, 272], [1280, 720, 784, 241], [1024, 768, 784, 260],
  [768, 1024, 753, 360], [820, 1180, 784, 421], [1180, 820, 784, 280], [1366, 1024, 784, 360],
  [962, 601, 784, 194], [601, 962, 589, 336], [1920, 1200, 784, 429], [390, 844, 382, 290], [360, 740, 353, 249]
]
const SCALES = [0.5, 0.75, 1, 1.25, 1.5] // Options > display scale, clamped 0.5..1.5
const cap = (vw, vh, scale) => discCapPx((v) => Math.min(vw, vh) * (v / 100) * scale)

describe('referee player disc sizing', () => {
  it('fits every measured tablet and phone court, at every display scale', () => {
    for (const [vw, vh, courtWidth, courtHeight] of MEASURED) {
      for (const scale of SCALES) {
        const problems = discFitProblems({ courtWidth, courtHeight, viewportWidth: vw, capPx: cap(vw, vh, scale) })
        expect(problems, `${vw}x${vh} court ${courtWidth}x${courtHeight} scale ${scale}`).toEqual([])
      }
    }
  })

  it('fits any court from phone to the 800 px page width', () => {
    for (let courtWidth = 340; courtWidth <= 790; courtWidth += 15) {
      for (let courtHeight = 150; courtHeight <= 560; courtHeight += 10) {
        for (const viewportWidth of [courtWidth + 8, 1024, 1920]) {
          for (const capPx of [20, 45, 70, 93, 116, 160, 400]) {
            const problems = discFitProblems({ courtWidth, courtHeight, viewportWidth, capPx })
            expect(problems, `court ${courtWidth}x${courtHeight} vw ${viewportWidth} cap ${capPx}`).toEqual([])
          }
        }
      }
    }
  })

  it('sizes the number, badges and ball from the disc, not the viewport', () => {
    const small = discMetrics({ courtWidth: 382, courtHeight: 290, capPx: 45 })
    const big = discMetrics({ courtWidth: 784, courtHeight: 429, capPx: 160 })
    expect(small.number / small.disc).toBeCloseTo(DISC.number)
    expect(big.number / big.disc).toBeCloseTo(DISC.number)
    expect(big.badge).toBeGreaterThan(small.badge)
    expect(big.badge).toBeLessThanOrEqual(DISC.badgeMaxPx)
    expect(small.badge).toBeGreaterThanOrEqual(DISC.badgeMinPx)
    expect(small.ball).toBeGreaterThan(0)
    expect(big.ball).toBeLessThanOrEqual(big.disc * DISC.ballMax)
  })

  it('the display scale never shrinks a disc below the floor, a small court does', () => {
    expect(discMetrics({ courtWidth: 784, courtHeight: 461, capPx: 20 }).disc).toBe(DISC.minPx)
    expect(discMetrics({ courtWidth: 784, courtHeight: 120, capPx: 200 }).disc).toBeCloseTo(0.26 * 120)
  })

  it('with LFP tracking on, keeps discs large enough for the LFP mark between the corner badges, and still fits', () => {
    // On a 36 px disc the !LFP mark overlapped the position and replaced-player badges
    expect(discMetrics({ courtWidth: 784, courtHeight: 461, capPx: 20, lfp: true }).disc).toBe(DISC.minPxLfp)
    expect(discCssVars(10, { lfp: true })['--disc']).toContain(`${DISC.minPxLfp}px`)
    expect(discCssVars(10)['--disc']).toContain(`${DISC.minPx}px`)
    for (const [vw, vh, courtWidth, courtHeight] of MEASURED) {
      for (const scale of SCALES) {
        const problems = discFitProblems({ courtWidth, courtHeight, viewportWidth: vw, capPx: cap(vw, vh, scale), lfp: true })
        expect(problems, `LFP ${vw}x${vh} scale ${scale}`).toEqual([])
      }
    }
  })

  it('reports what would overflow', () => {
    // A wide disc cap on a short court: the cqh limit keeps it in, so force a
    // narrow column with a tiny court instead.
    expect(discFitProblems({ courtWidth: 120, courtHeight: 400, viewportWidth: 1280, capPx: 200 }).join(' ')).toMatch(/front column/)
  })

  it('CSS custom properties use the same proportions, from the court box only', () => {
    const vars = discCssVars(93)
    expect(vars['--disc']).toBe(`min(${DISC.heightCqh}cqh, ${DISC.widthCqw}cqw, 93px)`)
    expect(discCssVars(10)['--disc']).toContain(`${DISC.minPx}px`)
    expect(vars['--disc-number']).toBe(`calc(var(--disc) * ${DISC.number})`)
    expect(vars['--disc-badge']).toBe(`clamp(${DISC.badgeMinPx}px, calc(var(--disc) * ${DISC.badge}), ${DISC.badgeMaxPx}px)`)
    expect(vars['--disc-ball']).toContain(`${DISC.ballRoomCqw}cqw`)
    for (const v of Object.values(vars)) expect(v).not.toMatch(/vw|vh|vmin|vmax|rem/)
  })
})
