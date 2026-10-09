// Team colours on the player discs (scoring court, referee tablet, bench
// tablet): every disc wears its team's shirt colour, the libero the colour
// that stands out most from both teams, and the shirt number is near-black or
// white, whichever has the higher contrast on the fill.
//
// Pure functions, no DOM: WCAG 2.x relative luminance + contrast ratio for
// readability, OKLab distance for "looks like a different shirt".

export const TEXT_DARK = '#1c1917' // stone-900
export const TEXT_LIGHT = '#ffffff'

// The light court the discs stand on (rgba(234, 179, 8, ~0.1) over the stone
// page, see .court in styles.css and the referee court)
export const COURT_SURFACE = '#f3ecda'

// Readable body text (WCAG AA). The shirt number is big and bold, so 3:1
// would pass as large text; we aim for 4.5:1 and outline below it.
export const MIN_TEXT_CONTRAST = 4.5
// Non-text contrast (WCAG 1.4.11): the disc's edge against the court
export const MIN_EDGE_CONTRAST = 3

// Distinct jersey-like colours a libero shirt is picked from
export const LIBERO_PALETTE = [
  { name: 'white', hex: '#ffffff' },
  { name: 'black', hex: '#1c1917' },
  { name: 'red', hex: '#e2001a' },
  { name: 'yellow', hex: '#facc15' },
  { name: 'orange', hex: '#f97316' },
  { name: 'green', hex: '#16a34a' },
  { name: 'sky', hex: '#38bdf8' },
  { name: 'blue', hex: '#1d4ed8' },
  { name: 'purple', hex: '#7c3aed' },
  { name: 'pink', hex: '#ec4899' },
  { name: 'grey', hex: '#a8a29e' }
]

// CSS names a colour field may hold (the CSS basic set plus common shirt names)
const NAMED = {
  white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', lime: '#00ff00', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', grey: '#808080', gray: '#808080',
  silver: '#c0c0c0', navy: '#000080', maroon: '#800000', teal: '#008080', aqua: '#00ffff', cyan: '#00ffff',
  fuchsia: '#ff00ff', magenta: '#ff00ff', olive: '#808000', gold: '#ffd700', brown: '#a52a2a',
  crimson: '#dc143c', violet: '#ee82ee', indigo: '#4b0082', turquoise: '#40e0d0', skyblue: '#87ceeb',
  royalblue: '#4169e1', darkblue: '#00008b', darkgreen: '#006400', darkred: '#8b0000', lightblue: '#add8e6',
  lightgrey: '#d3d3d3', lightgray: '#d3d3d3', darkgrey: '#a9a9a9', darkgray: '#a9a9a9', beige: '#f5f5dc',
  bordeaux: '#7b1e2b', burgundy: '#800020'
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)))

/**
 * Parse a colour: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() (comma or space
 * syntax, % allowed) or a CSS name. Returns { r, g, b, a } (0-255, a 0-1) or
 * null for anything else (empty, 'transparent', var(), gradients...).
 */
export function parseColour(input) {
  if (input == null) return null
  if (typeof input === 'object' && 'r' in input) return { r: clamp255(input.r), g: clamp255(input.g), b: clamp255(input.b), a: input.a ?? 1 }
  const s = String(input).trim().toLowerCase()
  if (!s) return null
  if (NAMED[s]) return parseColour(NAMED[s])
  let m = s.match(/^#?([0-9a-f]{3,8})$/)
  if (m && [3, 4, 6, 8].includes(m[1].length)) {
    let h = m[1]
    if (h.length <= 4) h = [...h].map(c => c + c).join('')
    const n = (i) => parseInt(h.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
  }
  m = s.match(/^rgba?\(\s*([^)]+)\)$/)
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const ch = (p) => (p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p))
    const [r, g, b] = parts.slice(0, 3).map(ch)
    if ([r, g, b].some(Number.isNaN)) return null
    const a = parts[3] == null ? 1 : (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]))
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: Number.isNaN(a) ? 1 : Math.max(0, Math.min(1, a)) }
  }
  return null
}

/** Opaque colour: a translucent one is laid over `under` (the court by default). */
function solid(input, under = COURT_SURFACE) {
  const c = parseColour(input)
  if (!c) return null
  if (c.a >= 1) return c
  const u = solid(under, '#ffffff')
  return { r: clamp255(c.r * c.a + u.r * (1 - c.a)), g: clamp255(c.g * c.a + u.g * (1 - c.a)), b: clamp255(c.b * c.a + u.b * (1 - c.a)), a: 1 }
}

/** '#rrggbb' (lower case) or null */
export function normaliseColour(input) {
  const c = solid(input)
  return c ? '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('') : null
}

const toLinear = (v) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.x relative luminance, 0 (black) to 1 (white); null if unparseable */
export function relativeLuminance(input) {
  const c = solid(input)
  if (!c) return null
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b)
}

/** WCAG contrast ratio, 1 to 21; null if either colour is unparseable */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  if (la == null || lb == null) return null
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** OKLab { L, a, b } (Björn Ottosson) */
export function toOklab(input) {
  const c = solid(input)
  if (!c) return null
  const r = toLinear(c.r), g = toLinear(c.g), b = toLinear(c.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  }
}

/**
 * Perceptual distance (OKLab ΔE × 100): 0 identical, ~2 just noticeable,
 * 100 black vs white. null if either colour is unparseable.
 */
export function colourDistance(a, b) {
  const x = toOklab(a)
  const y = toOklab(b)
  if (!x || !y) return null
  return 100 * Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b)
}

// WCAG large-text minimum: the shirt number is big and bold
export const MIN_LARGE_TEXT_CONTRAST = 3

// Pure black: the dark ink on the few mid tones (grey #808080, purple
// #a855f7...) where neither near-black nor white reaches 4.5:1
export const TEXT_BLACK = '#000000'

/**
 * The text colour on a team colour `bg` (shirt numbers, A/B chips, team
 * bands, score boxes): near-black or white, whichever has the higher WCAG
 * contrast ratio. Most of the text written on a team colour is small (9-11px
 * chips), so the ratio decides, with no lean towards white: grey, light
 * blue, purple and pink take dark text (white on grey is ~3.9:1, dark ~4.4).
 * Between L ≈ 0.18 and 0.22 neither reaches 4.5:1 (near-black stops at ~4.2),
 * so there the dark ink deepens to pure black, which reaches 4.6:1 or more:
 * every colour gets at least 4.5:1.
 */
export function readableTextOn(bg) {
  const dark = contrastRatio(bg, TEXT_DARK)
  const light = contrastRatio(bg, TEXT_LIGHT)
  if (dark == null) return TEXT_DARK
  if (Math.max(dark, light) < MIN_TEXT_CONTRAST && contrastRatio(bg, TEXT_BLACK) > Math.max(dark, light)) return TEXT_BLACK
  return dark >= light ? TEXT_DARK : TEXT_LIGHT
}

/**
 * Text colour for `bg` (readableTextOn) plus, when it stays under 4.5:1
 * (mid-tone fills), a 1px outline in the other one.
 * @returns {{ color: string, textShadow?: string, contrast: number }}
 */
export function readableText(bg) {
  const color = readableTextOn(bg)
  const contrast = contrastRatio(bg, color) ?? 21
  if (contrast >= MIN_TEXT_CONTRAST) return { color, contrast }
  const o = color === TEXT_LIGHT ? 'rgba(28, 25, 23, 0.85)' : 'rgba(255, 255, 255, 0.85)'
  return { color, contrast, textShadow: `-1px 0 ${o}, 1px 0 ${o}, 0 -1px ${o}, 0 1px ${o}` }
}

function mix(a, b, t) {
  const x = solid(a), y = solid(b)
  return normaliseColour({ r: clamp255(x.r + (y.r - x.r) * t), g: clamp255(x.g + (y.g - x.g) * t), b: clamp255(x.b + (y.b - x.b) * t), a: 1 })
}

/**
 * The disc's edge: null when the fill already stands out from the court
 * (≥ 3:1), otherwise a ring of the same colour, darkened on a light court
 * (lightened on a dark one) just enough to reach 3:1 — a white shirt gets a
 * grey ring, a yellow one an ochre ring.
 */
export function discRing(fill, surface = COURT_SURFACE) {
  const f = normaliseColour(fill)
  if (!f) return null
  if ((contrastRatio(f, surface) ?? 21) >= MIN_EDGE_CONTRAST) return null
  const towards = (relativeLuminance(surface) ?? 1) > 0.18 ? TEXT_DARK : TEXT_LIGHT
  for (let i = 2; i <= 20; i++) {
    const ring = mix(f, towards, i / 20)
    if (contrastRatio(ring, surface) >= MIN_EDGE_CONTRAST) return ring
  }
  return towards
}

/**
 * How well `candidate` works as a libero shirt next to the team's own shirt
 * and the opponent's: the weakest of (luminance contrast with the team
 * shirt, on a log scale to 0..100), (OKLab distance to the team shirt) and
 * (OKLab distance to the opponent shirt). Higher is better.
 */
export function liberoScore(candidate, teamColour, opponentColour) {
  const c = contrastRatio(candidate, teamColour) ?? 1
  const contrast = (100 * Math.log(c)) / Math.log(21)
  const toTeam = colourDistance(candidate, teamColour) ?? 100
  const toOpponent = opponentColour ? (colourDistance(candidate, opponentColour) ?? 100) : 100
  return Math.min(contrast, toTeam, toOpponent)
}

/**
 * The libero's shirt colour: an explicit libero colour from the match data
 * when there is one, otherwise the palette colour that stands out most from
 * both the team's shirt and the opponent's (see liberoScore). Ties keep the
 * palette order (white first).
 * @returns {string|null} '#rrggbb', null without a usable team colour
 */
export function liberoColour(teamColour, opponentColour = null, { explicit = null } = {}) {
  const own = normaliseColour(explicit)
  if (own) return own
  const team = normaliseColour(teamColour)
  if (!team) return null
  const opp = normaliseColour(opponentColour)
  let best = null
  for (const { hex } of LIBERO_PALETTE) {
    const score = liberoScore(hex, team, opp)
    if (!best || score > best.score + 1e-9) best = { hex, score }
  }
  return best.hex
}

// Two libero shirts closer than this (OKLab ΔE × 100) clash: red / orange /
// pink, blue / purple, white / yellow / sky / grey
export const LIBERO_CLASH_DISTANCE = 30

/**
 * The two liberos' shirts, chosen together so they also differ from each
 * other (navy vs black would otherwise give both teams a white libero).
 * Over every pair of palette colours (an explicit libero colour is kept as
 * is), it maximises the weakest of: each libero's liberoScore (contrast and
 * distance against its own team, distance from the opponent's shirt) and
 * the OKLab distance between the two liberos. That distance only limits the
 * pair while the two shirts clash (under LIBERO_CLASH_DISTANCE): past it they
 * are plainly different shirts, so when the teams' own best picks don't
 * clash both keep them. Ties go to the pair where the home libero scores
 * best on its own, then the away libero, then palette order. Deterministic.
 * @returns {{ home: string|null, away: string|null }} '#rrggbb' each, null for a team without a usable colour
 */
export function liberoPair(homeColour, awayColour, { home: homeExplicit = null, away: awayExplicit = null } = {}) {
  const home = normaliseColour(homeColour)
  const away = normaliseColour(awayColour)
  if (!home || !away) {
    return {
      home: liberoColour(home, away, { explicit: home ? homeExplicit : null }),
      away: liberoColour(away, home, { explicit: away ? awayExplicit : null })
    }
  }
  const palette = LIBERO_PALETTE.map(p => p.hex)
  const homeOptions = [normaliseColour(homeExplicit) ?? palette].flat()
  const awayOptions = [normaliseColour(awayExplicit) ?? palette].flat()
  const homeScore = new Map(homeOptions.map(c => [c, liberoScore(c, home, away)]))
  const awayScore = new Map(awayOptions.map(c => [c, liberoScore(c, away, home)]))
  const EPS = 1e-9
  let best = null
  for (const h of homeOptions) {
    for (const a of awayOptions) {
      const sh = homeScore.get(h)
      const sa = awayScore.get(a)
      const d = colourDistance(h, a)
      const joint = Math.min(sh, sa, d < LIBERO_CLASH_DISTANCE ? d : Infinity)
      const better = !best ||
        joint > best.joint + EPS ||
        (joint > best.joint - EPS && (sh > best.sh + EPS || (sh > best.sh - EPS && sa > best.sa + EPS)))
      if (better) best = { home: h, away: a, joint, sh, sa }
    }
  }
  return { home: best.home, away: best.away }
}

/** An explicit libero shirt colour on a team record, if the data has one */
export function teamLiberoColour(team) {
  if (!team || typeof team !== 'object') return null
  return normaliseColour(team.liberoColor ?? team.liberoColour ?? team.libero_color ?? team.libero_colour ?? null)
}

/**
 * Everything a disc needs for one fill.
 * @returns {{ background: string, color: string, textShadow?: string, ring: string|null } | null}
 */
export function discPaint(fill, surface = COURT_SURFACE) {
  const background = normaliseColour(fill)
  if (!background) return null
  const { color, textShadow } = readableText(background)
  return { background, color, textShadow, ring: discRing(background, surface) }
}

/**
 * Disc paint for a team's players and its libero.
 * @param {string|null} teamColour the team's shirt colour (null: no colour set)
 * @param {object} [opts]
 * @param {string|null} [opts.opponent] the other team's shirt colour
 * @param {string|null} [opts.libero] explicit libero shirt colour
 * @param {string} [opts.surface] the court colour under the discs
 * @returns {{ player: object, libero: object } | null} null without a usable team colour (callers keep their default look)
 */
export function teamDiscPaint(teamColour, { opponent = null, libero = null, surface = COURT_SURFACE } = {}) {
  const player = discPaint(teamColour, surface)
  if (!player) return null
  return { player, libero: discPaint(liberoColour(teamColour, opponent, { explicit: libero }), surface) }
}

/**
 * Disc paint for both teams of a match, with the two liberos picked together
 * (liberoPair) so they never share a shirt colour.
 * @param {string|null} homeColour
 * @param {string|null} awayColour
 * @param {object} [opts]
 * @param {string|null} [opts.homeLibero] explicit home libero colour
 * @param {string|null} [opts.awayLibero] explicit away libero colour
 * @param {string} [opts.surface] the court colour under the discs
 * @returns {{ home: { player: object, libero: object } | null, away: { player: object, libero: object } | null }} null for a team without a usable colour (callers keep their default look)
 */
export function matchDiscPaint(homeColour, awayColour, { homeLibero = null, awayLibero = null, surface = COURT_SURFACE } = {}) {
  const liberos = liberoPair(homeColour, awayColour, { home: homeLibero, away: awayLibero })
  const side = (colour, libero) => {
    const player = discPaint(colour, surface)
    return player ? { player, libero: discPaint(libero, surface) } : null
  }
  return { home: side(homeColour, liberos.home), away: side(awayColour, liberos.away) }
}

// The white header and panels the team name boxes sit on
export const HEADER_SURFACE = '#ffffff'
// The stone page under the panels (--ov-page, src/tailwind.css)
export const PAGE_SURFACE = '#f5f5f4'

/**
 * Inline style for a box filled with a team colour that shows a team name,
 * label (A/B) or score: the fill, the readable text colour (readableTextOn)
 * and, when the fill would melt into the white header (white, cream, light
 * yellow...), an inset ring of the same colour darkened to 3:1 (discRing). An
 * inset box-shadow, so the box keeps its size.
 * @param {string|null} colour the team colour
 * @param {object} [opts]
 * @param {string} [opts.fallback] colour used when `colour` is missing or unusable
 * @param {string} [opts.surface] what the box sits on
 * @param {number} [opts.ringWidth] px
 * @returns {{ background?: string, color?: string, boxShadow?: string }} (an unreadable colour such as a CSS variable is passed through with white text)
 */
export function teamBoxStyle(colour, { fallback = null, surface = HEADER_SURFACE, ringWidth = 2 } = {}) {
  const background = normaliseColour(colour) ?? normaliseColour(fallback)
  if (!background) {
    // Not a colour we can read (a CSS variable...): keep it, with white text as before
    const raw = typeof colour === 'string' && colour.trim() ? colour : (typeof fallback === 'string' && fallback.trim() ? fallback : null)
    return raw ? { background: raw, color: TEXT_LIGHT } : {}
  }
  const ring = discRing(background, surface)
  return ring
    ? { background, color: readableTextOn(background), boxShadow: `inset 0 0 0 ${ringWidth}px ${ring}` }
    : { background, color: readableTextOn(background) }
}

/** sRGB '#rrggbb' from OKLab, or null when it falls outside the sRGB gamut */
function fromOklab(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ]
  if (lin.some(v => v < -1e-4 || v > 1 + 1e-4)) return null
  const enc = (v) => {
    const c = Math.max(0, Math.min(1, v))
    return clamp255(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))
  }
  return '#' + lin.map(v => enc(v).toString(16).padStart(2, '0')).join('')
}

/** The colour at OKLab lightness L with the same hue and as much of its chroma as sRGB allows */
function atLightness(L, a, b) {
  const full = fromOklab(L, a, b)
  if (full) return full
  let lo = 0
  let hi = 1
  let best = fromOklab(L, 0, 0)
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2
    const c = fromOklab(L, a * t, b * t)
    if (c) { best = c; lo = t } else hi = t
  }
  return best
}

// A team colour this light and this grey is "white" (white, off-white, cream):
// a darker shade of it would read as a grey team, so it gets a swatch instead.
// On a dark background the same goes for black and near-black.
const NEAR_WHITE_L = 0.93
const NEAR_BLACK_L = 0.3
const NEAR_NEUTRAL_CHROMA = 0.06

/**
 * How to write text in a team's colour on `background` so it stays readable
 * (WCAG large-text 3:1) and still says which team it is:
 * - 'as-is': the team colour already reaches 3:1 and is used unchanged;
 * - 'shade': a darker (on a dark background, lighter) shade of the same hue,
 *   OKLab lightness moved just until it reaches 3:1, chroma kept as far as
 *   sRGB allows: yellow turns ochre, sky a deeper blue, light grey mid grey;
 * - 'swatch': a white or near-white team (near-black on a dark background),
 *   where a shade would read as a grey team: near-black (white) text on a
 *   small chip of the team colour, ringed (discRing) so the chip shows.
 * @param {string|null} colour the team colour
 * @param {string} [background] what the text sits on (default white)
 * @param {object} [opts]
 * @param {number} [opts.minContrast] default MIN_LARGE_TEXT_CONTRAST (3)
 * @returns {{ mode: 'as-is'|'shade'|'swatch', color: string, swatch: string|null, ring: string|null, contrast: number } | null} null when `colour` is not a readable colour
 */
export function teamTextPaint(colour, background = HEADER_SURFACE, { minContrast = MIN_LARGE_TEXT_CONTRAST } = {}) {
  const team = normaliseColour(colour)
  if (!team) return null
  const bg = normaliseColour(background) ?? HEADER_SURFACE
  const contrast = contrastRatio(team, bg)
  if (contrast >= minContrast) return { mode: 'as-is', color: team, swatch: null, ring: null, contrast }

  const lab = toOklab(team)
  const bgIsLight = relativeLuminance(bg) > 0.18
  const chroma = Math.hypot(lab.a, lab.b)
  const blendsIn = bgIsLight ? lab.L >= NEAR_WHITE_L : lab.L <= NEAR_BLACK_L
  if (blendsIn && chroma < NEAR_NEUTRAL_CHROMA) {
    const color = readableTextOn(team)
    return { mode: 'swatch', color, swatch: team, ring: discRing(team, bg), contrast: contrastRatio(team, color) }
  }

  // The lightness that just reaches minContrast: contrast grows as L moves
  // away from the background, so bisect between the team's own L and black
  // (white on a dark background)
  const passes = (L) => {
    const c = atLightness(L, lab.a, lab.b)
    return contrastRatio(c, bg) >= minContrast ? c : null
  }
  let near = lab.L
  let far = bgIsLight ? 0 : 1
  let best = passes(far) ?? (bgIsLight ? TEXT_DARK : TEXT_LIGHT)
  for (let i = 0; i < 24; i++) {
    const mid = (near + far) / 2
    const c = passes(mid)
    if (c) { best = c; far = mid } else near = mid
  }
  return { mode: 'shade', color: best, swatch: null, ring: null, contrast: contrastRatio(best, bg) }
}

/**
 * Inline style for TEXT drawn in a team's colour (a set-end A/B letter, a
 * score in the team colour) on `background`: the team colour when it reads
 * (≥ 3:1), else a darker shade of the same hue, and for a white team
 * near-black text on a small white chip with a grey ring (teamTextPaint).
 * A colour that can't be read (a CSS variable...) is passed through as is; a
 * missing one falls back to `fallback`, or to no style at all.
 * @param {string|null} colour the team colour
 * @param {string} [background] what the text sits on (default white)
 * @param {object} [opts]
 * @param {string} [opts.fallback] colour used when `colour` is missing or unusable
 * @param {number} [opts.minContrast]
 * @returns {{ color?: string, background?: string, boxShadow?: string, padding?: string, borderRadius?: string }}
 */
export function teamTextStyle(colour, background = HEADER_SURFACE, { fallback = null, minContrast = MIN_LARGE_TEXT_CONTRAST } = {}) {
  const usable = normaliseColour(colour) ? colour : (normaliseColour(fallback) ? fallback : null)
  const paint = teamTextPaint(usable, background, { minContrast })
  if (!paint) {
    const raw = typeof colour === 'string' && colour.trim() ? colour : (typeof fallback === 'string' && fallback.trim() ? fallback : null)
    return raw ? { color: raw } : {}
  }
  if (paint.mode !== 'swatch') return { color: paint.color }
  return {
    color: paint.color,
    background: paint.swatch,
    padding: '0 0.3em',
    borderRadius: '0.25em',
    ...(paint.ring ? { boxShadow: `inset 0 0 0 1.5px ${paint.ring}` } : {})
  }
}

/**
 * A badge colour that stays apart from the disc under it: `preferred` unless
 * it is too close to the fill (OKLab ΔE < 15), then `fallback`.
 */
export function markColourOn(fill, preferred, fallback) {
  const d = colourDistance(fill, preferred)
  return d != null && d < 15 ? fallback : preferred
}

// The team colour picker's twelve shirts (MatchSetup), grouped by colour
// family. Any other '#rrggbb' is a custom colour.
export const TEAM_COLOUR_PRESETS = [
  '#FFFFFF', // White
  '#000000', // Black
  '#808080', // Gray
  '#dc2626', // Red
  '#f97316', // Orange
  '#eab308', // Yellow
  '#22c55e', // Light Green
  '#065f46', // Dark Green
  '#3b82f6', // Light Blue
  '#1e3a8a', // Dark Blue
  '#a855f7', // Purple
  '#ec4899' // Pink
]

// A new match's team colours, both presets so the picker opens on a shirt
// tile, not on Custom: home the red shirt, away the light blue one
export const DEFAULT_HOME_COLOUR = '#dc2626'
export const DEFAULT_AWAY_COLOUR = '#3b82f6'

/** The preset the colour is (case and #rgb shorthand ignored), or null */
export function presetColour(colour) {
  const c = normaliseColour(colour)
  if (!c) return null
  return TEAM_COLOUR_PRESETS.find(p => normaliseColour(p) === c) ?? null
}

/** A readable colour that is none of the twelve presets */
export function isCustomColour(colour) {
  return normaliseColour(colour) != null && presetColour(colour) == null
}

/**
 * A hex code typed by hand: '#rrggbb', 'rrggbb', '#rgb' or 'rgb' (any case,
 * spaces around it ignored) as '#rrggbb' in lower case; null otherwise.
 */
export function parseHexColour(input) {
  if (typeof input !== 'string') return null
  const m = input.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1]
  return `#${h.toLowerCase()}`
}

// Two team colours closer than this (OKLab ΔE × 100) are hard to tell apart
// on the court: red #dc2626 next to #ef4444 is 6, navy next to the dark blue
// preset 6, two greens #22c55e / #16a34a 9.8. Red #ef4444 next to the orange
// preset (10.4) or the pink one (11.4) still reads as two shirts, and the
// closest two presets (red / pink, orange / yellow) are 14.5.
export const CLOSE_COLOUR_DISTANCE = 10

/**
 * Whether two team colours look alike (colourDistance under
 * CLOSE_COLOUR_DISTANCE); false when either is missing or unreadable.
 */
export function coloursTooClose(a, b) {
  const d = colourDistance(a, b)
  return d != null && d < CLOSE_COLOUR_DISTANCE
}
