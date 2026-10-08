// Coin toss: the Scoresheet menu sat right above "Confirm the coin toss" and
// opened downward, over it (parity with OpenBeach 838946a, video 2026-10-08).
// It opens upward now, as the Scoresheet menu of the match end does.
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const SRC = fs.readFileSync(path.resolve(__dirname, '../CoinToss.jsx'), 'utf8')

/** The opening <MenuList ...> tag (up to its items) that holds `marker`. */
function menuListTagWith(source, marker) {
  let at = 0
  for (;;) {
    const start = source.indexOf('<MenuList', at)
    if (start < 0) return null
    const end = source.indexOf('items=', start)
    const tag = source.slice(start, end)
    if (tag.includes(marker)) return tag
    at = start + 1
  }
}

describe('coin toss: the Scoresheet menu', () => {
  it('opens upward, away from the confirm button under it', () => {
    const tag = menuListTagWith(SRC, "t('header.scoresheet')")
    expect(tag).toBeTruthy()
    expect(tag).toMatch(/vertical="top"/)
    // the confirm button follows the menu in the page
    expect(SRC.indexOf("t('coinToss.confirmResult')")).toBeGreaterThan(SRC.indexOf(tag))
  })
})
