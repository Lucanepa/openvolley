// @vitest-environment node
// Animations off (Options › Effects and speed, utils/lookSettings:
// <html data-no-motion>): the rules at the end of tailwind.css. jsdom draws
// nothing, so these read the stylesheets and the sources; the look itself was
// checked in Chromium (Playwright, 22.11.2026: nothing moves on Home, in
// Options or on the scoring screen but the spinners, and a restyle of the
// scoring screen at 6x costs no more with the animations off).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../tailwind.css'), 'utf8')
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')

/** The body of the rule whose selector list ends with `last` (its last selector). */
function ruleEndingWith(last) {
  const text = withoutComments(css)
  const at = text.indexOf(`${last} {`)
  expect(at, last).toBeGreaterThanOrEqual(0)
  const open = at + last.length + 1
  const start = text.lastIndexOf('}', at) + 1
  return {
    body: text.slice(open + 1, text.indexOf('}', open)),
    selectors: text.slice(start, open).split(',').map((x) => x.trim()),
    at,
    text
  }
}

/** The depth of `{` blocks at `at` (0: unlayered, outside any @media). */
function depthAt(text, at) {
  let depth = 0
  for (const ch of text.slice(0, at)) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
  }
  return depth
}

const ANIMATIONS = "html[data-no-motion] [style*='animation']:not([style*='spin'])"
const TRANSITIONS = "html[data-no-motion] [style*='transition']"
const SPINNERS = ['.animate-spin', '.svrz-orbit', '.ov-spinner-late']

/** The class names (".x") a selector list names. */
const classesOf = (selectors) => new Set(selectors.flatMap((sel) => [...sel.replace(/\\/g, '').matchAll(/\.([\w[\]-]+)/g)].map((m) => `.${m[1]}`)))

/** Every innermost `selector { body }` of a stylesheet (keyframe steps included, harmless). */
function rulesOf(text) {
  return [...withoutComments(text).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }))
}

const sourceFiles = () => {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === '__tests__' || name === 'node_modules') continue
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(jsx?|tsx?)$/.test(name)) files.push(p)
    }
  }
  walk(resolve(__dirname, '..'))
  walk(resolve(__dirname, '../../scoresheet_pdf'))
  return files
}

describe('html[data-no-motion]: nothing moves', () => {
  it('no animation on what animates, over inline styles too (!important)', () => {
    const { body } = ruleEndingWith(ANIMATIONS)
    expect(body.trim()).toBe('animation: none !important;')
    // animation: none, never a 0 s duration: an animation that ends hidden
    // (the rally tap notice) would end hidden at once
    expect(body).not.toMatch(/animation-duration/)
  })

  it('no transition on what transitions, over inline styles too', () => {
    const { body } = ruleEndingWith(TRANSITIONS)
    expect(body).toMatch(/transition-duration: 0s !important;/)
    expect(body).toMatch(/transition-delay: 0s !important;/)
  })

  it('no smooth scrolling', () => {
    expect(ruleEndingWith('html[data-no-motion]').body).toMatch(/scroll-behavior: auto !important;/)
  })

  it('only on what moves, never on every element (a rule on every element made each restyle 20-30 % slower)', () => {
    const text = withoutComments(css)
    const selectors = [...text.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(',')).map((x) => x.trim()).filter((x) => x.startsWith('html[data-no-motion]'))
    expect(selectors.length).toBeGreaterThan(20)
    for (const sel of selectors) {
      const rest = sel.slice('html[data-no-motion]'.length).trim()
      if (!rest) continue // <html> itself
      // the element part names a class or the style attribute, never * or a bare :not()
      expect(rest, sel).toMatch(/^(?:[a-z]+)?(?:\.[\w\\[\]-]+|\[style\*=)/)
      expect(rest, sel).not.toMatch(/(^|\s)\*|^:not\(/)
    }
  })

  it('are unlayered and outside any block, so they beat the kit and the legacy layer', () => {
    for (const last of [ANIMATIONS, TRANSITIONS, 'html[data-no-motion]']) {
      const { at, text } = ruleEndingWith(last)
      expect(depthAt(text, at), last).toBe(0)
      expect(at).toBeGreaterThan(text.indexOf('@layer theme, base, legacy, components, utilities;'))
    }
  })

  it('every class of the stylesheets that animates or transitions is in the lists', () => {
    const stopped = classesOf(ruleEndingWith(ANIMATIONS).selectors)
    const still = classesOf(ruleEndingWith(TRANSITIONS).selectors)
    let checked = 0
    for (const file of ['../styles.css', '../ui/tokens.css', '../tailwind.css']) {
      for (const { selector, body } of rulesOf(readFileSync(resolve(__dirname, file), 'utf8'))) {
        if (selector.includes('data-no-motion') || selector.includes('eink')) continue
        const animates = /(?:^|[;\s])animation(?:-name)?\s*:\s*(?!none|inherit)[a-z]/i.test(body)
        const transitions = /(?:^|[;\s])transition\s*:\s*(?!none)[a-z0-9]/i.test(body)
        if (!animates && !transitions) continue
        const named = classesOf(selector.split(','))
        if (SPINNERS.some((c) => named.has(c))) continue // spinners turn on
        checked++
        if (animates) expect([...named].some((c) => stopped.has(c)), `${file}: ${selector}`).toBe(true)
        if (transitions) expect([...named].some((c) => still.has(c)), `${file}: ${selector}`).toBe(true)
      }
    }
    expect(checked).toBeGreaterThan(10)
  })

  it('every Tailwind animation and transition class the app uses is in the lists', () => {
    const stopped = classesOf(ruleEndingWith(ANIMATIONS).selectors)
    const still = classesOf(ruleEndingWith(TRANSITIONS).selectors)
    const used = new Set()
    for (const f of sourceFiles()) {
      const text = readFileSync(f, 'utf8')
      for (const m of text.matchAll(/(?<![\w-])(animate-[a-z]+|transition(?:-[a-z]+|-\[[^\]\s'"`]+\])?)(?![\w-])/g)) used.add(m[1])
    }
    expect(used.has('transition-colors')).toBe(true)
    for (const name of used) {
      if (['animate-spin', 'animate-none', 'transition-none'].includes(name)) continue
      const covered = name.startsWith('animate-') ? stopped : still
      expect(covered.has(`.${name}`), name).toBe(true)
    }
  })

  it('spinners keep turning: none of them is in the lists, and every inline spinner is told by \'spin\' in its name', () => {
    const named = classesOf(ruleEndingWith(ANIMATIONS).selectors)
    for (const c of SPINNERS) expect(named.has(c), c).toBe(false)
    // React writes style={{ animation: 'spin 1s linear infinite' }} through
    // the CSSOM, and Chromium serializes it as "animation: 1s linear 0s
    // infinite normal none running spin": the name is found anywhere in it.
    // Every inline animation with 'spin' in its name is a spinner, and no
    // other one has it (they stop).
    // the animation names of the inline animations ("animation: ... ? 'name 0.5s ...'")
    const inline = sourceFiles().flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((line) => /\banimation: /.test(line))
      .flatMap((line) => [...line.matchAll(/[`']([A-Za-z][\w-]*) (?:[\d.]+m?s|\$\{\w+\}ms)\b/g)].map((m) => m[1])))
    expect(inline).toContain('spin')
    expect(inline).toContain('recentSubFlash')
    for (const name of inline) {
      if (/spin/i.test(name)) expect(name).toBe('spin')
    }
  })

  it('a screen\'s loading spinner keeps its short wait, without the fade', () => {
    expect(ruleEndingWith('html[data-no-motion] .ov-spinner-late').body).toMatch(/animation-duration: 0s !important;/)
    // its delay and fill (tokens.css): no spinner for a read that answers at once
    expect(readFileSync(resolve(__dirname, '../ui/tokens.css'), 'utf8')).toMatch(/\.ov-spinner-late \{\s*animation: ov-spinner-late 160ms ease-out 140ms both;/)
  })
})

describe('the state cues keep a still look', () => {
  it('the Line-up buttons stay green-lit (the narrow glow at full strength)', () => {
    expect(ruleEndingWith('html[data-no-motion] .lineup-button::before').body).toMatch(/opacity: 1;/)
    // the button and both glows stop together
    const named = ruleEndingWith(ANIMATIONS).selectors
    for (const sel of ['.lineup-button', '.lineup-button::before', '.lineup-button::after', '.missing-signature-button::before']) {
      expect(named).toContain(`html[data-no-motion] ${sel}`)
    }
  })

  it('Missing signature shows the strong amber, drawn by the button (as under reduced motion)', () => {
    const button = ruleEndingWith('html[data-no-motion] .missing-signature-button').body
    expect(button).toMatch(/background: #fcd34d;/)
    expect(button).toMatch(/border-color: #b45309;/)
    expect(ruleEndingWith('html[data-no-motion] .missing-signature-button::before').body).toMatch(/display: none;/)
    // the same colours as the reduced-motion look of styles.css
    const legacy = readFileSync(resolve(__dirname, '../styles.css'), 'utf8')
    const reduced = legacy.slice(legacy.lastIndexOf('@media (prefers-reduced-motion: reduce)', legacy.indexOf('.missing-signature-button {\n    background: #fcd34d;')))
    expect(reduced).toMatch(/\.missing-signature-button \{\s*background: #fcd34d;\s*border-color: #b45309;/)
  })
})
