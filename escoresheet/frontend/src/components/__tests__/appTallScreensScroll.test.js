/**
 * The coin toss, Match End and home screens are centred in a scrolling panel.
 * With plain `align-items: center`, a screen taller than the window overflowed
 * at the top as well, where a scroll container cannot reach (seen on the
 * desktop: Match End's title cut off, up to 396 px out of reach). `safe
 * center` centres only what fits. App.jsx is too large to mount and jsdom has
 * no layout: this pins the panel style.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const app = readFileSync(resolve(__dirname, '../../App.jsx'), 'utf8')

describe('a screen taller than the window scrolls to its top', () => {
  it('the centred panel uses safe centring', () => {
    const start = app.indexOf("...(!matchId || showCoinToss || showMatchEnd ? {")
    expect(start).toBeGreaterThan(-1)
    const block = app.slice(start, app.indexOf('} : {})', start))
    expect(block).toContain("alignItems: 'safe center'")
  })
})
