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
