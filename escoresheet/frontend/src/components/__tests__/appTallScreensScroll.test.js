/**
 * The coin toss, Match End and home screens are centred in a scrolling panel.
 * With plain `align-items: center`, a screen taller than the window overflowed
 * at the top as well, where a scroll container cannot reach (seen on the
 * desktop: Match End's title cut off, up to 396 px out of reach). `safe
 * center` behind @supports did not hold either: the Android app still cut the
 * home page's title off (2026-10-13), a WebView that parses `safe` without
 * honouring it in flexbox. Auto margins on the panel's children centre what
 * fits and start the rest at its top in every engine; they live in the
 * .panel--centred class (an inline style cannot reach the children).
 * App.jsx is too large to mount and jsdom has no layout: this pins the class
 * and its CSS.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const app = readFileSync(resolve(__dirname, '../../App.jsx'), 'utf8')
const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf8')

describe('a screen taller than the window scrolls to its top', () => {
  it('the centred panel gets the .panel--centred class and no inline alignItems', () => {
    expect(app).toContain(
      "className={(!matchId || showCoinToss || showMatchEnd) ? 'panel panel--centred' : 'panel'}"
    )
    const start = app.indexOf("...(!matchId || showCoinToss || showMatchEnd ? {")
    expect(start).toBeGreaterThan(-1)
    const block = app.slice(start, app.indexOf('} : {})', start))
    expect(block).not.toContain('alignItems')
  })

  it('.panel--centred centres its screen with auto margins, never by align-items alone', () => {
    expect(css).toMatch(/\.panel--centred\s*\{\s*align-items:\s*flex-start;\s*\}/)
    // !important: the kit's `.ov-kit { margin: 0 }` (components layer) beats
    // the legacy layer this file is in, and the home page's root is an .ov-kit
    expect(css).toMatch(/\.panel--centred > \*\s*\{\s*margin-top:\s*auto !important;\s*margin-bottom:\s*auto !important;\s*\}/)
    // A plain or "safe" centre on the panel would overflow at the top again
    expect(css).not.toMatch(/\.panel--centred\s*\{[^}]*align-items:\s*(safe )?center/)
  })
})
