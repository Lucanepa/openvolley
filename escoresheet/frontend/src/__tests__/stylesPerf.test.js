// @vitest-environment node
// The scoring screen's looping flashes and its tap hints, drawn cheaply for
// the hall tablet (Galaxy Tab A7 Lite: PowerVR GE8320, Cortex-A53). A keyframe
// that animates box-shadow, background or border-color runs on the main
// thread: style, paint and raster of the button 60 times a second, under the
// dialog that opens over it. Opacity alone runs on the compositor. These read
// the stylesheet and the screen's source text (jsdom draws nothing).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8')
const scoreboard = readFileSync(resolve(__dirname, '../components/Scoreboard.jsx'), 'utf8')

/** The text of the block that opens at `start` (the index of a `{`), without its braces. */
function blockAt(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(start + 1, i)
  }
  throw new Error('unclosed block')
}

/** The body of `@keyframes name`. */
function keyframes(name) {
  const at = css.search(new RegExp(`@keyframes ${name}\\s*\\{`))
  expect(at, `@keyframes ${name}`).toBeGreaterThanOrEqual(0)
  return blockAt(css, css.indexOf('{', at))
}

/** The property names a keyframes body sets. */
const animatedProperties = (body) => [...new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]))]

/** The bodies of the rules whose selector list is exactly `selector`, anywhere in the sheet. */
function rulesFor(selector, text = css) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')
  const re = new RegExp(`(^|[}\\s])${escaped}\\s*\\{`, 'g')
  return [...text.matchAll(re)].map((m) => blockAt(text, m.index + m[0].length - 1))
}

/** The `@media (prefers-reduced-motion: reduce)` blocks. */
const reducedMotionBlocks = () =>
  [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{/g)].map((m) => blockAt(css, m.index + m[0].length - 1))

describe('Line-up buttons: the flash runs on the compositor', () => {
  it('lineupFlash and both glows animate only opacity', () => {
    for (const name of ['lineupFlash', 'lineupGlowNarrow', 'lineupGlowWide']) {
      expect(animatedProperties(keyframes(name)), name).toEqual(['opacity'])
    }
  })

  it('the glows are layers of their own that follow the button\'s animation', () => {
    const shared = rulesFor('.lineup-button::before,\n.lineup-button::after').join('\n')
    expect(shared).toMatch(/content: '';/)
    expect(shared).toMatch(/position: absolute;/)
    expect(shared).toMatch(/pointer-events: none;/)
    expect(shared).toMatch(/opacity: 0;/)
    expect(shared).toMatch(/animation: inherit;/)
    const narrow = rulesFor('.lineup-button::before').join('\n')
    const wide = rulesFor('.lineup-button::after').join('\n')
    // the 0% / 100% and the 50% glow of the old box-shadow keyframes
    expect(narrow).toMatch(/box-shadow: 0 0 20px rgba\(34, 197, 94, 0\.5\);/)
    expect(narrow).toMatch(/animation-name: lineupGlowNarrow;/)
    expect(wide).toMatch(/box-shadow: 0 0 30px rgba\(34, 197, 94, 0\.8\);/)
    expect(wide).toMatch(/animation-name: lineupGlowWide;/)
  })

  it('stands still under reduced motion, over the inline animation', () => {
    const blocks = reducedMotionBlocks().join('\n')
    expect(rulesFor('.lineup-button', blocks).join('\n')).toMatch(/animation: none !important;/)
  })

  it('stands still while the line-up dialog is open over it (both buttons)', () => {
    expect(scoreboard.match(/animation: lineupModal \? 'none' : 'lineupFlash 1\.5s ease-in-out infinite'/g)).toHaveLength(2)
    expect(scoreboard).not.toMatch(/animation: 'lineupFlash/)
  })
})

describe('Missing signature: the flash runs on the compositor', () => {
  const button = () => rulesFor('.missing-signature-button').join('\n')
  const layer = () => rulesFor('.missing-signature-button::before').join('\n')

  it('missingSignatureFlash animates only opacity, of a layer under the text', () => {
    expect(animatedProperties(keyframes('missingSignatureFlash'))).toEqual(['opacity'])
    expect(button()).toMatch(/position: relative;/)
    expect(button()).toMatch(/isolation: isolate;/)
    expect(button()).not.toMatch(/animation/)
    expect(layer()).toMatch(/z-index: -1;/)
    expect(layer()).toMatch(/inset: -2px;/)
    expect(layer()).toMatch(/opacity: 0;/)
    expect(layer()).toMatch(/animation: missingSignatureFlash 1\.2s ease-in-out infinite;/)
  })

  it('the button keeps the flash\'s two ends: pale at rest, the layer the strong amber of its peak', () => {
    expect(button()).toMatch(/background: #fef3c7;/)
    expect(button()).toMatch(/border: 2px solid #d97706;/)
    expect(layer()).toMatch(/background: #fcd34d;/)
    expect(layer()).toMatch(/box-shadow: inset 0 0 0 2px #b45309, 0 0 0 4px rgba\(217, 119, 6, 0\.35\);/)
  })

  it('stands still under its dialog (data-still) and, strong amber, under reduced motion', () => {
    expect(rulesFor('.missing-signature-button[data-still]::before').join('\n')).toMatch(/animation: none;/)
    const reduced = rulesFor('.missing-signature-button::before', reducedMotionBlocks().join('\n')).join('\n')
    expect(reduced).toMatch(/animation: none;/)
    expect(reduced).toMatch(/opacity: 1;/)
  })

  it('the scoring screen stills both buttons while a signing dialog is open', () => {
    expect(scoreboard.match(/still=\{!!preMatchSignTeam \|\| signaturesMissingOpen\}/g)).toHaveLength(2)
  })
})

describe('Tap hints: one offscreen layer per finger', () => {
  const finger = () => rulesFor('.tap-hint:not(:disabled)::after,\n[data-tap-hint]::after').join('\n')

  it('the 0.6 is the group opacity in the mask image, in both mask declarations', () => {
    const masks = [...finger().matchAll(/^\s*(-webkit-mask|mask): url\("([^"]+)"\)/gm)]
    expect(masks.map((m) => m[1])).toEqual(['-webkit-mask', 'mask'])
    for (const [, , uri] of masks) {
      const svg = decodeURIComponent(uri.replace(/^data:image\/svg\+xml,/, ''))
      // every path of the finger inside the one group
      expect(svg).toMatch(/^<svg [^>]*><g opacity='0\.6'>(<path d='[^']+'\/>){5}<\/g><\/svg>$/)
    }
    expect(masks[0][2]).toBe(masks[1][2])
  })

  it('the pseudo-element itself has no opacity (it would be a second layer)', () => {
    expect(finger()).not.toMatch(/(^|\s)opacity:/m)
    expect(finger()).toMatch(/background-color: currentColor;/)
  })
})

describe('Point and Start rally: a pressed look the moment the finger lands', () => {
  const point = () => rulesFor('.rally-point-button:not(:disabled):active').join('\n')
  const start = () => rulesFor('.rally-controls button.start-rally-button:not(:disabled):active').join('\n')

  it('a wash inside the button, nothing else', () => {
    expect(point()).toMatch(/^\s*box-shadow: inset 0 0 0 999px rgba\(0, 0, 0, 0\.12\);\s*$/)
    // Start rally keeps the hairline of .rally-controls button.secondary under the wash
    expect(rulesFor('.rally-controls button.secondary').join('\n')).toMatch(/box-shadow: inset 0 0 0 1px var\(--ov-hairline-strong\);/)
    expect(start()).toMatch(/^\s*box-shadow: inset 0 0 0 1px var\(--ov-hairline-strong\), inset 0 0 0 999px rgba\(0, 0, 0, 0\.12\);\s*$/)
  })

  it('no transform, filter, blur, opacity or transition on any :active rule', () => {
    for (const m of css.matchAll(/([^{}]*:active[^{}]*)\{/g)) {
      const body = blockAt(css, m.index + m[0].length - 1)
      expect(body, m[1].trim()).not.toMatch(/transform|filter|blur|opacity|transition/)
    }
  })
})
