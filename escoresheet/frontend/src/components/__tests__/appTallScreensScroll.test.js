/**
 * The coin toss, Match End and home screens are centred in a scrolling panel.
 * With plain `align-items: center`, a screen taller than the window overflowed
 * at the top as well, where a scroll container cannot reach (seen on the
 * desktop: Match End's title cut off, up to 396 px out of reach). `safe
 * center` centres only what fits. Older engines (Chrome/WebView < 115, Safari
 * < 17.6) reject `safe`, so the panel needs a plain `center` fallback, which an
 * inline style cannot carry: the value lives in the .panel--centred class.
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

  it('.panel--centred centres, and uses safe centring where supported', () => {
    expect(css).toMatch(/\.panel--centred\s*\{\s*align-items:\s*center;\s*\}/)
    expect(css).toMatch(
      /@supports \(align-items: safe center\)\s*\{\s*\.panel--centred\s*\{\s*align-items:\s*safe center;\s*\}\s*\}/
    )
  })
})
