import { describe, it, expect } from 'vitest'
import {
  parseColour, normaliseColour, relativeLuminance, contrastRatio, colourDistance,
  readableTextOn, readableText, discRing, liberoColour, liberoScore, teamLiberoColour,
  discPaint, teamDiscPaint, markColourOn, liberoPair, matchDiscPaint, teamBoxStyle,
  teamTextPaint, teamTextStyle, toOklab,
  LIBERO_CLASH_DISTANCE, HEADER_SURFACE, TEXT_DARK, TEXT_LIGHT, TEXT_BLACK, COURT_SURFACE, LIBERO_PALETTE, MIN_TEXT_CONTRAST, MIN_EDGE_CONTRAST, MIN_LARGE_TEXT_CONTRAST
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
    expect(readableTextOn('#38bdf8')).toBe(TEXT_DARK) // sky
    expect(readableTextOn('#000080')).toBe(TEXT_LIGHT) // navy
    expect(readableTextOn('#1c1917')).toBe(TEXT_LIGHT)
    expect(readableTextOn('#e2001a')).toBe(TEXT_LIGHT) // Swiss Volley red
  })

  it('takes the higher WCAG ratio on mid tones too, with no lean towards white', () => {
    // white on these is 3.4-4.0:1, too little for the 9-11px chips; dark reads better
    for (const bg of ['#8a8a8a', '#3b82f6', '#ec4899', '#ef4444', '#16a34a', '#0d9488']) {
      expect(contrastRatio(bg, TEXT_DARK), bg).toBeGreaterThan(contrastRatio(bg, TEXT_LIGHT))
      expect(readableTextOn(bg), bg).toBe(TEXT_DARK)
    }
    // white where it has the higher ratio
    for (const bg of ['#dc2626', '#e2001a', '#065f46', '#1e3a8a', '#7b1e2b']) expect(readableTextOn(bg), bg).toBe(TEXT_LIGHT)
  })

  it('deepens near-black to pure black on the mid tones where neither reaches 4.5:1', () => {
    for (const bg of ['#808080', '#a855f7']) {
      expect(Math.max(contrastRatio(bg, TEXT_DARK), contrastRatio(bg, TEXT_LIGHT)), bg).toBeLessThan(MIN_TEXT_CONTRAST)
      expect(readableTextOn(bg), bg).toBe(TEXT_BLACK)
      expect(contrastRatio(bg, TEXT_BLACK), bg).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
    }
  })

  it('every #rrggbb (step 17) gets at least 4.5:1, the best of near-black and white', () => {
    const steps = Array.from({ length: 16 }, (_, i) => i * 17)
    let min = Infinity
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const bg = normaliseColour({ r, g, b })
      const ink = readableTextOn(bg)
      const c = contrastRatio(bg, ink)
      min = Math.min(min, c)
      expect(c, bg).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
      if (ink !== TEXT_BLACK) expect(c, bg).toBeCloseTo(Math.max(contrastRatio(bg, TEXT_DARK), contrastRatio(bg, TEXT_LIGHT)), 9)
    }
    expect(min).toBeLessThan(4.6) // the true minimum sits right at 4.5:1
  })

  it('never picks a colour under the 3:1 large-text minimum when the other one passes', () => {
    // orange: white is only ~2.8:1
    expect(contrastRatio('#f97316', TEXT_LIGHT)).toBeLessThan(MIN_LARGE_TEXT_CONTRAST)
    expect(readableTextOn('#f97316')).toBe(TEXT_DARK)
    for (const bg of [...PALETTE, '#ef4444', '#3b82f6', '#808080', '#0ea5e9', '#22c55e', '#f97316', '#7b1e2b', '#ffd700', '#84cc16', '#c0c0c0']) {
      expect(contrastRatio(bg, readableTextOn(bg)), bg).toBeGreaterThanOrEqual(MIN_LARGE_TEXT_CONTRAST)
    }
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

  it('no colour needs the outline any more: the ink always reaches 4.5:1', () => {
    for (const bg of ['#808080', '#8a8a8a', '#a855f7', '#3b82f6']) expect(readableText(bg).textShadow, bg).toBeUndefined()
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

describe('liberoPair', () => {
  const pairs = [
    ['navy vs black', '#000080', '#000000'],
    ['black vs navy', '#000000', '#000080'],
    ['white vs white', '#ffffff', '#ffffff'],
    ['red vs red', '#e2001a', '#e2001a'],
    ['black vs black', '#000000', '#000000'],
    ['navy vs navy', '#000080', '#000080'],
    ['red vs blue', '#ef4444', '#3b82f6'],
    ['white vs black', '#ffffff', '#000000'],
    ['yellow vs orange', '#facc15', '#f97316'],
    ['yellow vs green', '#facc15', '#16a34a'],
    ['red vs pink', '#e2001a', '#ec4899'],
    ['two blues', '#1d4ed8', '#2563eb'],
    ['sky vs blue', '#38bdf8', '#1d4ed8'],
    ['grey vs white', '#808080', '#ffffff']
  ]
  const joint = (h, a, home, away) => {
    const d = colourDistance(h, a)
    return Math.min(liberoScore(h, home, away), liberoScore(a, away, home), d < LIBERO_CLASH_DISTANCE ? d : Infinity)
  }

  it.each(pairs)('%s: two different liberos, each apart from both shirts', (_, home, away) => {
    const p = liberoPair(home, away)
    expect(PALETTE).toContain(p.home)
    expect(PALETTE).toContain(p.away)
    expect(colourDistance(p.home, p.away)).toBeGreaterThanOrEqual(LIBERO_CLASH_DISTANCE)
    expect(contrastRatio(p.home, home)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(p.away, away)).toBeGreaterThanOrEqual(3)
    expect(colourDistance(p.home, away)).toBeGreaterThanOrEqual(25)
    expect(colourDistance(p.away, home)).toBeGreaterThanOrEqual(25)
    // and no other pair of palette colours does better on the weakest term
    let best = -1
    for (const h of PALETTE) for (const a of PALETTE) best = Math.max(best, joint(h, a, home, away))
    expect(joint(p.home, p.away, home, away)).toBeCloseTo(best, 9)
  })

  it('navy vs black: the two liberos are no longer both white', () => {
    expect(liberoColour('#000080', '#000000')).toBe('#ffffff')
    expect(liberoColour('#000000', '#000080')).toBe('#ffffff')
    expect(liberoPair('#000080', '#000000')).toEqual({ home: '#ffffff', away: '#f97316' }) // white, orange
    expect(liberoPair('#000000', '#000080')).toEqual({ home: '#ffffff', away: '#f97316' })
  })

  it('white vs white and red vs red: home keeps its best pick, away takes the next', () => {
    expect(liberoPair('#ffffff', '#ffffff')).toEqual({ home: '#1c1917', away: '#1d4ed8' }) // black, blue
    expect(liberoPair('#e2001a', '#e2001a')).toEqual({ home: '#ffffff', away: '#1c1917' }) // white, black
  })

  it('keeps both teams\' own best picks when they do not clash', () => {
    for (const [home, away] of [['#ffffff', '#000000'], ['#e2001a', '#ec4899'], ['#ef4444', '#3b82f6'], ['#38bdf8', '#1d4ed8']]) {
      const solo = { home: liberoColour(home, away), away: liberoColour(away, home) }
      if (colourDistance(solo.home, solo.away) >= LIBERO_CLASH_DISTANCE) expect(liberoPair(home, away), `${home} vs ${away}`).toEqual(solo)
    }
    // white vs black: blue and red, as each team picks alone
    expect(liberoPair('#ffffff', '#000000')).toEqual({ home: '#1d4ed8', away: '#e2001a' })
  })

  it('is deterministic', () => {
    for (const [, home, away] of pairs) expect(liberoPair(home, away)).toEqual(liberoPair(home, away))
  })

  it('works around an explicit libero colour, and keeps both when both are given', () => {
    // away's libero is white: home (navy) must not be white too
    const p = liberoPair('#000080', '#000000', { away: '#ffffff' })
    expect(p.away).toBe('#ffffff')
    expect(colourDistance(p.home, '#ffffff')).toBeGreaterThanOrEqual(LIBERO_CLASH_DISTANCE)
    expect(liberoPair('#000080', '#000000', { home: '#00ff00', away: '#ff00ff' })).toEqual({ home: '#00ff00', away: '#ff00ff' })
  })

  it('falls back to a single pick when a team has no colour', () => {
    expect(liberoPair('#e2001a', null)).toEqual({ home: liberoColour('#e2001a'), away: null })
    expect(liberoPair(null, '#e2001a')).toEqual({ home: null, away: liberoColour('#e2001a') })
    expect(liberoPair(null, null)).toEqual({ home: null, away: null })
  })
})

describe('matchDiscPaint', () => {
  it('paints both teams, with the two liberos picked together', () => {
    const m = matchDiscPaint('#000080', '#000000')
    expect(m.home.player.background).toBe('#000080')
    expect(m.away.player.background).toBe('#000000')
    expect(m.home.libero.background).toBe('#ffffff')
    expect(m.away.libero.background).toBe('#f97316')
    expect(m.away.libero.color).toBe(readableTextOn('#f97316'))
    expect(m.home.libero.ring).toBeTruthy() // a white libero gets its ring on the court
  })

  it('null for a team without a colour, and honours explicit libero colours', () => {
    const m = matchDiscPaint('#e2001a', '', { homeLibero: '#00ff00' })
    expect(m.away).toBeNull()
    expect(m.home.libero.background).toBe('#00ff00')
  })
})

describe('teamBoxStyle', () => {
  it('fills with the team colour and the readable text colour', () => {
    expect(teamBoxStyle('#e2001a')).toEqual({ background: '#e2001a', color: readableTextOn('#e2001a') })
    expect(teamBoxStyle('#1c1917')).toEqual({ background: '#1c1917', color: TEXT_LIGHT })
    expect(teamBoxStyle('#facc15').color).toBe(TEXT_DARK)
  })

  it('a white or very light team keeps a ring on the white header, and dark text', () => {
    for (const c of ['#ffffff', '#fff8e7', '#fef9c3', '#f5f5dc']) {
      const st = teamBoxStyle(c)
      expect(st.color, c).toBe(TEXT_DARK)
      const ring = st.boxShadow.match(/#[0-9a-f]{6}/)[0]
      expect(ring, c).toBe(discRing(c, HEADER_SURFACE))
      expect(contrastRatio(ring, HEADER_SURFACE), c).toBeGreaterThanOrEqual(MIN_EDGE_CONTRAST)
      expect(st.boxShadow).toMatch(/^inset 0 0 0 2px #/)
    }
    expect(teamBoxStyle('#e2001a').boxShadow).toBeUndefined()
  })

  it('uses the fallback for a missing colour and passes an unreadable one through', () => {
    expect(teamBoxStyle(null, { fallback: '#3b82f6' }).background).toBe('#3b82f6')
    expect(teamBoxStyle('var(--accent)')).toEqual({ background: 'var(--accent)', color: TEXT_LIGHT })
    expect(teamBoxStyle(null)).toEqual({})
  })
})

// OKLab hue angle and chroma, to check a shade keeps the team's hue
const hueOf = (c) => { const o = toOklab(c); return Math.atan2(o.b, o.a) * 180 / Math.PI }
const chromaOf = (c) => { const o = toOklab(c); return Math.hypot(o.a, o.b) }
const hueGap = (x, y) => { const d = Math.abs(hueOf(x) - hueOf(y)) % 360; return d > 180 ? 360 - d : d }

describe('teamTextPaint / teamTextStyle', () => {
  it('keeps a team colour that already reads on white unchanged', () => {
    for (const c of ['#e2001a', '#ef4444', '#3b82f6', '#1d4ed8', '#16a34a', '#1c1917', '#7c3aed', '#ec4899']) {
      const p = teamTextPaint(c)
      expect(p.mode, c).toBe('as-is')
      expect(p.color, c).toBe(c)
      expect(teamTextStyle(c), c).toEqual({ color: c })
    }
  })

  it('red vs blue on white: both unchanged', () => {
    expect(teamTextStyle('#ef4444')).toEqual({ color: '#ef4444' })
    expect(teamTextStyle('#3b82f6')).toEqual({ color: '#3b82f6' })
  })

  it('darkens yellow, sky, light grey and other light colours to 3:1, same hue', () => {
    for (const c of ['#ffff00', '#facc15', '#eab308', '#38bdf8', '#87ceeb', '#00ffff', '#4ade80', '#f97316', '#ffc0cb', '#d3d3d3', '#c0c0c0']) {
      const p = teamTextPaint(c)
      expect(p.mode, c).toBe('shade')
      const ratio = contrastRatio(p.color, HEADER_SURFACE)
      expect(ratio, c).toBeGreaterThanOrEqual(MIN_LARGE_TEXT_CONTRAST)
      // just enough, not a jump to near-black
      expect(ratio, c).toBeLessThan(MIN_LARGE_TEXT_CONTRAST + 0.15)
      expect(toOklab(p.color).L, c).toBeLessThan(toOklab(c).L)
      if (chromaOf(c) > 0.05) {
        expect(hueGap(p.color, c), c).toBeLessThan(4)
        expect(chromaOf(p.color), c).toBeGreaterThan(0.05)
      } else {
        expect(chromaOf(p.color), c).toBeLessThan(0.02) // a grey stays grey
      }
      expect(teamTextStyle(c), c).toEqual({ color: p.color })
    }
  })

  it('turns yellow into an ochre, sky into a deeper sky, light grey into mid grey', () => {
    const yellow = teamTextPaint('#facc15').color
    expect(hueGap(yellow, '#facc15')).toBeLessThan(2)
    expect(colourDistance(yellow, '#facc15')).toBeLessThan(colourDistance(yellow, '#1c1917'))
    const sky = teamTextPaint('#38bdf8').color
    expect(hueGap(sky, '#38bdf8')).toBeLessThan(2)
    expect(teamTextPaint('#d3d3d3').color).toMatch(/^#9[0-9a-f]{5}$/)
  })

  it('a white or near-white team: near-black text on a white chip with a ring', () => {
    for (const c of ['#ffffff', '#fafaf9', '#fffdd0', 'white']) {
      const p = teamTextPaint(c)
      expect(p.mode, c).toBe('swatch')
      expect(p.color, c).toBe(TEXT_DARK)
      expect(p.swatch, c).toBe(normaliseColour(c))
      expect(p.ring, c).toBe(discRing(c, HEADER_SURFACE))
      expect(contrastRatio(p.ring, HEADER_SURFACE), c).toBeGreaterThanOrEqual(MIN_EDGE_CONTRAST)
      const st = teamTextStyle(c)
      expect(st.color, c).toBe(TEXT_DARK)
      expect(st.background, c).toBe(normaliseColour(c))
      expect(st.boxShadow, c).toBe(`inset 0 0 0 1.5px ${p.ring}`)
      expect(st.padding).toBeTruthy()
    }
  })

  it('white vs black on white: the white team gets the chip, black stays black', () => {
    expect(teamTextStyle('#ffffff').background).toBe('#ffffff')
    expect(teamTextStyle('#000000')).toEqual({ color: '#000000' })
  })

  it('measures against the background it is given', () => {
    // on the stone page a light grey needs a slightly darker shade than on white
    const onPage = teamTextPaint('#d3d3d3', '#f5f5f4').color
    expect(contrastRatio(onPage, '#f5f5f4')).toBeGreaterThanOrEqual(MIN_LARGE_TEXT_CONTRAST)
    // on a dark background a light colour reads as is, a dark one is lightened
    expect(teamTextPaint('#ffffff', TEXT_DARK).mode).toBe('as-is')
    const blue = teamTextPaint('#1d4ed8', TEXT_DARK)
    expect(blue.mode).toBe('shade')
    expect(toOklab(blue.color).L).toBeGreaterThan(toOklab('#1d4ed8').L)
    expect(contrastRatio(blue.color, TEXT_DARK)).toBeGreaterThanOrEqual(MIN_LARGE_TEXT_CONTRAST)
    expect(teamTextPaint('#000000', TEXT_DARK).mode).toBe('swatch')
    // an unreadable background counts as white
    expect(teamTextPaint('#ffffff', 'var(--panel)').mode).toBe('swatch')
  })

  it('honours a stricter minimum', () => {
    const p = teamTextPaint('#3b82f6', HEADER_SURFACE, { minContrast: MIN_TEXT_CONTRAST })
    expect(p.mode).toBe('shade')
    expect(contrastRatio(p.color, HEADER_SURFACE)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
  })

  it('falls back, passes CSS variables through, and returns no style without a colour', () => {
    expect(teamTextPaint(null)).toBeNull()
    expect(teamTextPaint('var(--x)')).toBeNull()
    expect(teamTextStyle('var(--accent)')).toEqual({ color: 'var(--accent)' })
    expect(teamTextStyle(null)).toEqual({})
    expect(teamTextStyle('', HEADER_SURFACE, { fallback: '#ef4444' })).toEqual({ color: '#ef4444' })
    expect(teamTextStyle(null, HEADER_SURFACE, { fallback: '#ffff00' }).color).toBe(teamTextPaint('#ffff00').color)
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

describe('custom team colours (any hex, not only the twelve presets)', () => {
  // A deterministic spread of arbitrary colours: a 9-step RGB cube plus a
  // pseudo-random sample
  const ANY = (() => {
    const out = []
    const steps = [0, 32, 64, 96, 128, 160, 192, 224, 255]
    for (const r of steps) for (const g of steps) for (const b of steps) out.push(normaliseColour({ r, g, b }))
    let seed = 7
    for (let i = 0; i < 400; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648
      out.push('#' + (seed % 0x1000000).toString(16).padStart(6, '0'))
    }
    return out
  })()

  it('parseHexColour takes #rrggbb, rrggbb, #rgb and rgb in any case, nothing else', async () => {
    const { parseHexColour } = await import('../teamColours')
    expect(parseHexColour('#1A7F5A')).toBe('#1a7f5a')
    expect(parseHexColour('1a7f5a')).toBe('#1a7f5a')
    expect(parseHexColour('#0aF')).toBe('#00aaff')
    expect(parseHexColour(' fff ')).toBe('#ffffff')
    for (const bad of ['', '#', '#12', '#1234', '#12345', '#1234567', '#12345678', 'blue', 'rgb(1,2,3)', '#ggg', null, undefined, 123]) {
      expect(parseHexColour(bad), String(bad)).toBeNull()
    }
  })

  it('presetColour / isCustomColour tell the twelve presets from any other colour', async () => {
    const { presetColour, isCustomColour, TEAM_COLOUR_PRESETS } = await import('../teamColours')
    expect(TEAM_COLOUR_PRESETS).toHaveLength(12)
    for (const p of TEAM_COLOUR_PRESETS) {
      expect(presetColour(p)).toBe(p)
      expect(presetColour(p.toLowerCase())).toBe(p)
      expect(isCustomColour(p)).toBe(false)
    }
    expect(presetColour('#fff')).toBe('#FFFFFF')
    expect(presetColour('#ef4444')).toBeNull() // the default home red is no preset
    expect(isCustomColour('#ef4444')).toBe(true)
    expect(isCustomColour('#7b1e2b')).toBe(true)
    expect(isCustomColour('')).toBe(false)
    expect(isCustomColour(null)).toBe(false)
    expect(isCustomColour('var(--x)')).toBe(false)
  })

  it('coloursTooClose flags near shades and the same colour, never two different presets', async () => {
    const { coloursTooClose, TEAM_COLOUR_PRESETS, CLOSE_COLOUR_DISTANCE } = await import('../teamColours')
    expect(coloursTooClose('#dc2626', '#dc2626')).toBe(true)
    expect(coloursTooClose('#dc2626', '#ef4444')).toBe(true)
    expect(coloursTooClose('#dc2626', '#e2001a')).toBe(true)
    expect(coloursTooClose('#1e3a8a', '#1e3a5f')).toBe(true)
    expect(coloursTooClose('#ffffff', '#f8fafc')).toBe(true)
    expect(coloursTooClose('#3b82f6', '#2563eb')).toBe(true)
    expect(coloursTooClose('#dc2626', '#3b82f6')).toBe(false)
    expect(coloursTooClose('#22c55e', '#16a34a')).toBe(true) // two greens
    expect(coloursTooClose('#ef4444', '#f97316')).toBe(false) // red next to the orange preset
    expect(coloursTooClose('#ef4444', '#ec4899')).toBe(false) // and the pink one
    expect(coloursTooClose('#ffffff', '#000000')).toBe(false)
    for (const a of TEAM_COLOUR_PRESETS) {
      for (const b of TEAM_COLOUR_PRESETS) {
        if (a !== b) expect(coloursTooClose(a, b), `${a} ${b}`).toBe(false)
      }
    }
    expect(coloursTooClose('#dc2626', null)).toBe(false)
    expect(coloursTooClose(undefined, '#dc2626')).toBe(false)
    expect(coloursTooClose('not a colour', '#dc2626')).toBe(false)
    expect(colourDistance('#dc2626', '#ef4444')).toBeLessThan(CLOSE_COLOUR_DISTANCE)
  })

  it('readableTextOn picks near-black, black or white for any colour, at least 3:1', () => {
    for (const c of ANY) {
      const ink = readableTextOn(c)
      expect([TEXT_DARK, TEXT_LIGHT, TEXT_BLACK], c).toContain(ink)
      expect(contrastRatio(c, ink), c).toBeGreaterThanOrEqual(MIN_LARGE_TEXT_CONTRAST)
      // never the worse of the two when only one reaches 3:1
      const other = ink === TEXT_LIGHT ? TEXT_DARK : TEXT_LIGHT
      if (contrastRatio(c, other) < MIN_LARGE_TEXT_CONTRAST) expect(contrastRatio(c, ink), c).toBeGreaterThan(contrastRatio(c, other))
    }
    // very light and very dark custom shirts
    expect(readableTextOn('#fef9c3')).toBe(TEXT_DARK)
    expect(readableTextOn('#0b1d3a')).toBe(TEXT_LIGHT)
    expect(readableTextOn('#7b1e2b')).toBe(TEXT_LIGHT)
    expect(readableTextOn('#a3e635')).toBe(TEXT_DARK)
    // #rgb is read as #rrggbb
    expect(readableTextOn('#ff0')).toBe(readableTextOn('#ffff00'))
  })

  it('teamBoxStyle and discPaint give every colour a readable text and a visible edge', () => {
    for (const c of ANY) {
      const box = teamBoxStyle(c)
      expect(box.background, c).toBe(c)
      expect(contrastRatio(box.background, box.color), c).toBeGreaterThanOrEqual(MIN_LARGE_TEXT_CONTRAST)
      if (contrastRatio(c, HEADER_SURFACE) < MIN_EDGE_CONTRAST) expect(box.boxShadow, c).toMatch(/^inset 0 0 0 2px #[0-9a-f]{6}$/)
      const disc = discPaint(c)
      expect(contrastRatio(disc.background, disc.color), c).toBeGreaterThanOrEqual(MIN_LARGE_TEXT_CONTRAST)
      const edge = disc.ring ?? disc.background
      expect(contrastRatio(edge, COURT_SURFACE), c).toBeGreaterThanOrEqual(MIN_EDGE_CONTRAST - 0.05)
      const text = teamTextPaint(c)
      expect(text.contrast, c).toBeGreaterThanOrEqual(MIN_LARGE_TEXT_CONTRAST - 0.01)
    }
  })
})
