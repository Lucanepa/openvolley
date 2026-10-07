import { describe, it, expect } from 'vitest'
import {
  parseColour, normaliseColour, relativeLuminance, contrastRatio, colourDistance,
  readableTextOn, readableText, discRing, liberoColour, liberoScore, teamLiberoColour,
  discPaint, teamDiscPaint, markColourOn,
  TEXT_DARK, TEXT_LIGHT, COURT_SURFACE, LIBERO_PALETTE, MIN_TEXT_CONTRAST, MIN_EDGE_CONTRAST
} from '../teamColours'

const PALETTE = LIBERO_PALETTE.map(p => p.hex)

describe('parseColour / normaliseColour', () => {
  it('reads hex, rgb() and CSS names', () => {
    expect(normaliseColour('#E2001A')).toBe('#e2001a')
    expect(normaliseColour('#abc')).toBe('#aabbcc')
    expect(normaliseColour('e2001a')).toBe('#e2001a')
    expect(normaliseColour('rgb(226, 0, 26)')).toBe('#e2001a')
    expect(normaliseColour('rgb(226 0 26)')).toBe('#e2001a')
    expect(normaliseColour('rgba(100%, 0%, 0%, 1)')).toBe('#ff0000')
    expect(normaliseColour('Navy')).toBe('#000080')
    expect(normaliseColour('white')).toBe('#ffffff')
    expect(parseColour('#ff000080')).toMatchObject({ r: 255, g: 0, b: 0 })
    expect(parseColour('#ff000080').a).toBeCloseTo(0.5, 2)
  })

  it('lays a translucent colour over the court', () => {
    expect(normaliseColour('rgba(255, 255, 255, 0)')).toBe(COURT_SURFACE)
  })

  it('returns null for anything that is not a colour', () => {
    for (const v of [null, undefined, '', '  ', 'transparent', 'var(--x)', 'image.png', '#12', 'linear-gradient(red, blue)', 'rgb(1,2)']) {
      expect(normaliseColour(v), String(v)).toBeNull()
    }
  })
})

describe('WCAG luminance and contrast', () => {
  it('matches the reference values', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6)
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6)
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2159, 3)
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 6)
    // Known pairs (WebAIM contrast checker)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
    expect(contrastRatio('#ff0000', '#ffffff')).toBeCloseTo(4.0, 2)
    expect(contrastRatio('#0000ff', '#ffffff')).toBeCloseTo(8.59, 2)
    expect(contrastRatio('#e2001a', '#ffffff')).toBeCloseTo(4.98, 1)
    // symmetric
    expect(contrastRatio('#3b82f6', '#1c1917')).toBeCloseTo(contrastRatio('#1c1917', '#3b82f6'), 9)
  })

  it('OKLab distance: 0 for the same colour, 100 for black vs white', () => {
    expect(colourDistance('#e2001a', 'rgb(226,0,26)')).toBeCloseTo(0, 6)
    expect(colourDistance('#000000', '#ffffff')).toBeCloseTo(100, 0)
    expect(colourDistance('#000000', '#000080')).toBeLessThan(colourDistance('#000000', '#ffff00'))
  })
})

describe('readableTextOn', () => {
  it('picks near-black or white, whichever contrasts more', () => {
    expect(readableTextOn('#ffffff')).toBe(TEXT_DARK)
    expect(readableTextOn('#facc15')).toBe(TEXT_DARK) // yellow
    expect(readableTextOn('#000080')).toBe(TEXT_LIGHT) // navy
    expect(readableTextOn('#1c1917')).toBe(TEXT_LIGHT)
    expect(readableTextOn('#e2001a')).toBe(TEXT_LIGHT) // Swiss Volley red
    expect(readableTextOn('#16a34a')).toBe(TEXT_DARK)
  })

  it('every palette colour and every common shirt gets ≥ 4.5:1, or an outline', () => {
    const shirts = [...PALETTE, '#ef4444', '#3b82f6', '#000080', '#808080', '#0ea5e9', '#22c55e', '#f97316', '#7b1e2b', '#ffd700']
    for (const bg of shirts) {
      const t = readableText(bg)
      expect(contrastRatio(bg, t.color), bg).toBeCloseTo(t.contrast, 6)
      if (t.contrast < MIN_TEXT_CONTRAST) expect(t.textShadow, bg).toMatch(/1px/)
      else expect(t.textShadow, bg).toBeUndefined()
    }
  })

  it('a mid grey falls under 4.5:1 with both and gets an outline in the other colour', () => {
    const t = readableText('#808080')
    expect(t.contrast).toBeLessThan(MIN_TEXT_CONTRAST)
    expect(t.textShadow).toBeTruthy()
  })
})

describe('discRing', () => {
  it('leaves colours that stand out from the court alone', () => {
    for (const c of ['#e2001a', '#1c1917', '#000080', '#1d4ed8', '#7c3aed']) expect(discRing(c), c).toBeNull()
  })

  it('gives a white or yellow disc a darker ring of its own colour reaching 3:1 on the court', () => {
    for (const c of ['#ffffff', '#facc15', '#f5f5dc', '#38bdf8']) {
      const ring = discRing(c)
      expect(ring, c).toMatch(/^#[0-9a-f]{6}$/)
      expect(contrastRatio(ring, COURT_SURFACE), c).toBeGreaterThanOrEqual(MIN_EDGE_CONTRAST)
      expect(relativeLuminance(ring), c).toBeLessThan(relativeLuminance(c))
    }
    // a yellow shirt's ring stays yellowish (ochre), not grey
    const ochre = parseColour(discRing('#facc15'))
    expect(ochre.r).toBeGreaterThan(ochre.b + 60)
  })

  it('on a dark court, lightens a dark disc instead', () => {
    const ring = discRing('#1c1917', '#111111')
    expect(contrastRatio(ring, '#111111')).toBeGreaterThanOrEqual(MIN_EDGE_CONTRAST)
    expect(relativeLuminance(ring)).toBeGreaterThan(relativeLuminance('#1c1917'))
  })

  it('returns null without a colour', () => {
    expect(discRing(null)).toBeNull()
  })
})

describe('liberoColour', () => {
  const pairs = [
    ['red vs blue', '#ef4444', '#3b82f6'],
    ['white vs white', '#ffffff', '#ffffff'],
    ['red vs red', '#e2001a', '#e2001a'],
    ['black vs navy', '#000000', '#000080'],
    ['navy vs black', '#000080', '#000000'],
    ['yellow vs orange', '#facc15', '#f97316'],
    ['white vs black', '#ffffff', '#000000'],
    ['yellow vs green', '#facc15', '#16a34a'],
    ['red vs pink', '#e2001a', '#ec4899'],
    ['two blues', '#1d4ed8', '#2563eb'],
    ['sky vs blue', '#38bdf8', '#1d4ed8'],
    ['grey vs white', '#808080', '#ffffff']
  ]

  it.each(pairs)('%s: the libero stands apart from both shirts', (_, team, opp) => {
    const lib = liberoColour(team, opp)
    expect(PALETTE).toContain(lib)
    expect(contrastRatio(lib, team)).toBeGreaterThanOrEqual(3)
    expect(colourDistance(lib, team)).toBeGreaterThanOrEqual(30)
    expect(colourDistance(lib, opp)).toBeGreaterThanOrEqual(25)
    // and no palette colour does better
    const best = Math.max(...PALETTE.map(c => liberoScore(c, team, opp)))
    expect(liberoScore(lib, team, opp)).toBeCloseTo(best, 9)
  })

  it('picks the expected shirts for real pairs', () => {
    expect(liberoColour('#ffffff', '#ffffff')).toBe('#1c1917') // white vs white: black
    expect(liberoColour('#e2001a', '#e2001a')).toBe('#ffffff') // red vs red: white
    expect(liberoColour('#000000', '#000080')).toBe('#ffffff') // black vs navy: white
    expect(liberoColour('#facc15', '#f97316')).toBe('#1c1917') // yellow vs orange: black
    // white vs black: neither white nor black, a strong colour
    expect(['#ffffff', '#1c1917']).not.toContain(liberoColour('#ffffff', '#000000'))
  })

  it('takes the opponent into account', () => {
    // Black shirts: white is the natural libero, unless the opponent wears white
    expect(liberoColour('#000000', '#e2001a')).toBe('#ffffff')
    expect(liberoColour('#000000', '#ffffff')).not.toBe('#ffffff')
  })

  it('uses an explicit libero colour when the data has one', () => {
    expect(liberoColour('#e2001a', '#3b82f6', { explicit: '#00ff00' })).toBe('#00ff00')
    expect(liberoColour('#e2001a', '#3b82f6', { explicit: 'nonsense' })).not.toBe('nonsense')
    expect(teamLiberoColour({ color: '#e2001a', liberoColor: '#123456' })).toBe('#123456')
    expect(teamLiberoColour({ color: '#e2001a', libero_color: 'white' })).toBe('#ffffff')
    expect(teamLiberoColour({ color: '#e2001a' })).toBeNull()
    expect(teamLiberoColour(null)).toBeNull()
  })

  it('works without an opponent colour, and is null without a team colour', () => {
    expect(PALETTE).toContain(liberoColour('#e2001a'))
    expect(liberoColour(null, '#ffffff')).toBeNull()
    expect(liberoColour('', '#ffffff')).toBeNull()
  })
})

describe('discPaint / teamDiscPaint', () => {
  it('paints players in the team colour and the libero in its contrasting colour', () => {
    const p = teamDiscPaint('#e2001a', { opponent: '#3b82f6' })
    expect(p.player).toMatchObject({ background: '#e2001a', color: TEXT_LIGHT, ring: null })
    expect(p.libero.background).toBe(liberoColour('#e2001a', '#3b82f6'))
    expect(p.libero.color).toBe(readableTextOn(p.libero.background))
  })

  it('white shirts get dark numbers and a ring', () => {
    const p = discPaint('#fff')
    expect(p).toMatchObject({ background: '#ffffff', color: TEXT_DARK })
    expect(p.ring).toBeTruthy()
  })

  it('returns null without a usable team colour (callers keep the default look)', () => {
    expect(teamDiscPaint(null)).toBeNull()
    expect(teamDiscPaint('')).toBeNull()
    expect(discPaint('var(--x)')).toBeNull()
  })

  it('honours an explicit libero colour', () => {
    expect(teamDiscPaint('#e2001a', { libero: '#00ff00' }).libero.background).toBe('#00ff00')
  })
})

describe('markColourOn', () => {
  it('keeps the preferred mark colour unless it melts into the fill', () => {
    expect(markColourOn('#e2001a', '#3b82f6', '#0f172a')).toBe('#3b82f6')
    expect(markColourOn('#3b82f6', '#3b82f6', '#0f172a')).toBe('#0f172a')
    expect(markColourOn('#2563eb', '#3b82f6', '#0f172a')).toBe('#0f172a')
    expect(markColourOn(null, '#3b82f6', '#0f172a')).toBe('#3b82f6')
  })
})
