// @vitest-environment node
/**
 * The roster editor at about 800-1050 px (iPad landscape 1024x768, a phone on
 * its side): the card's grid column was as wide as the bench table, so
 * "Choose players", the counts card and the Delete column ran off the card.
 * The column is the card's width now and the tables shrink into it (their
 * dates of birth keep room for DD.MM.YYYY). jsdom lays nothing out: the sizes
 * were measured in Chromium at 1024x768, 844x390, 1280x800 and 360x780.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf8')
const setup = readFileSync(resolve(__dirname, '../MatchSetup.jsx'), 'utf8')
const rule = (selector) => {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at))
}

describe('the roster editor fits its card', () => {
  it('one column as wide as the card, the tables no wider than it', () => {
    expect(rule('.setup.setup-roster')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(rule('.setup-roster :is(.roster-grid, .bench-grid)')).toMatch(/max-width:\s*100%/)
  })

  it('both roster views carry the class, every date of birth its minimum', () => {
    expect(setup.match(/className=\{cn\(SETUP_VIEW, 'setup-roster'\)\}/g)).toHaveLength(2)
    expect(setup).toMatch(/const DOB_CELL = 'cell-dob min-w-32'/)
    expect(setup).not.toMatch(/wrapperClassName="cell-dob"/)
    // the add-player box shrinks with the card too
    expect(setup.match(/mx-auto w-max max-w-full rounded-xl/g)).toHaveLength(2)
  })
})
