// @vitest-environment node
// Animations off (Options › Effects and speed, utils/lookSettings:
// <html data-no-motion>): the rules at the end of tailwind.css. jsdom draws
// nothing, so these read the stylesheet and the sources; the look itself was
// checked in Chromium (Playwright, 22.11.2026).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../tailwind.css'), 'utf8')
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')

/** The body of the rule whose selector list is exactly `selector`. */
function ruleFor(selector) {
  const text = withoutComments(css)
  const at = text.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  const open = at + selector.length + 1
  return { body: text.slice(open + 1, text.indexOf('}', open)), at, text }
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

const STOP = "html[data-no-motion] :not(.animate-spin, .svrz-orbit, [style*='animation: spin']),\nhtml[data-no-motion] ::before,\nhtml[data-no-motion] ::after"

describe('html[data-no-motion]: nothing moves', () => {
  it('no animation, no transition, no smooth scroll, over inline styles too (!important)', () => {
    const { body } = ruleFor(STOP)
    expect(body).toMatch(/animation: none !important;/)
    expect(body).toMatch(/transition-duration: 0s !important;/)
    expect(body).toMatch(/transition-delay: 0s !important;/)
    expect(body).toMatch(/scroll-behavior: auto !important;/)
    // animation: none, never a 0 s duration: an animation that ends hidden
    // (the rally tap notice) would end hidden at once
    expect(body).not.toMatch(/animation-duration/)
  })

  it('is unlayered and outside any block, so it beats the kit and the legacy layer', () => {
    const { at, text } = ruleFor(STOP)
    expect(depthAt(text, at)).toBe(0)
    expect(at).toBeGreaterThan(text.indexOf('@layer theme, base, legacy, components, utilities;'))
  })

  it('spinners keep turning: every inline spinner of the app is a \'spin\' animation the rule leaves alone', () => {
    // React writes style={{ animation: 'spin 1s linear infinite' }} as
    // style="animation: spin 1s linear infinite;"
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
    const inlineSpins = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/animation: '(spin[^']*)'/g)].map((m) => m[1]))
    expect(inlineSpins.length).toBeGreaterThan(0)
    for (const value of inlineSpins) expect(`animation: ${value}`).toMatch(/^animation: spin /)
  })
})

describe('the state cues keep a still look', () => {
  it('the Line-up buttons stay green-lit (the narrow glow at full strength)', () => {
    expect(ruleFor('html[data-no-motion] .lineup-button::before').body).toMatch(/opacity: 1;/)
  })

  it('Missing signature shows the strong amber, drawn by the button (as under reduced motion)', () => {
    const button = ruleFor('html[data-no-motion] .missing-signature-button').body
    expect(button).toMatch(/background: #fcd34d;/)
    expect(button).toMatch(/border-color: #b45309;/)
    expect(ruleFor('html[data-no-motion] .missing-signature-button::before').body).toMatch(/display: none;/)
    // the same colours as the reduced-motion look of styles.css
    const legacy = readFileSync(resolve(__dirname, '../styles.css'), 'utf8')
    const reduced = legacy.slice(legacy.lastIndexOf('@media (prefers-reduced-motion: reduce)', legacy.indexOf('.missing-signature-button {\n    background: #fcd34d;')))
    expect(reduced).toMatch(/\.missing-signature-button \{\s*background: #fcd34d;\s*border-color: #b45309;/)
  })
})
