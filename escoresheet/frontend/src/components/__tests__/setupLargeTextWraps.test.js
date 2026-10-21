// @vitest-environment node
/**
 * 360 px at 130 % text: the nowrap "Load match from schedule" button widened
 * the Match info card past the column (its right border and values cut off),
 * and a long team name in the roster editor's header (an auto grid column)
 * widened the page. On a phone the buttons wrap their label; the header name
 * wraps anywhere. jsdom lays nothing out: measured in Chromium at 360x780 and
 * 412x915 (130 %), 360x780 and 1280x800 (100 %).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const setup = readFileSync(resolve(__dirname, '../MatchSetup.jsx'), 'utf8')

describe('Match setup at large text on a phone', () => {
  it('the Match info card buttons wrap their label on a phone', () => {
    const buttons = setup.match(/className="whitespace-nowrap max-sm:flex-auto[^"]*"/g)
    expect(buttons).toHaveLength(3)
    for (const b of buttons) expect(b).toContain('max-sm:whitespace-normal')
    for (const b of buttons) expect(b).toContain('max-sm:h-auto')
  })

  it('the roster headers\' team name shrinks and wraps', () => {
    const headers = setup.match(/<h2 className="[^"]*">\{(home|away) \|\| t\('matchSetup\.(home|away)Team'\)\}<\/h2>/g)
    expect(headers).toHaveLength(2)
    for (const h of headers) {
      expect(h).toContain('min-w-0')
      expect(h).toContain('[overflow-wrap:anywhere]')
    }
  })
})
