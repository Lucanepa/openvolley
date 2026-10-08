import { describe, it, expect } from 'vitest'
import { COURT_CELLS, PHONE_COURT_MIN_PX, PHONE_SQUARE_MIN_PX, PHONE_SQUARE_RESERVE_PX, POSITIONS, detectDisplayMode, isPhoneScreen, officialRoleShort, phoneHeldSideways, phoneLayoutActive, phoneLayoutKept, recentActions, tintOf } from '../phoneLayout'

describe('detectDisplayMode (the automatic display mode)', () => {
  it.each([[390, 844], [360, 740], [412, 915], [599, 1000]])('a %ix%i portrait phone gets the phone layout', (w, h) => {
    expect(detectDisplayMode({ width: w, height: h, hasTouch: true })).toBe('phone')
    expect(detectDisplayMode({ width: w, height: h, hasTouch: false })).toBe('phone')
  })

  it('a phone turned to landscape is no phone layout (tablet with touch, as before)', () => {
    expect(detectDisplayMode({ width: 844, height: 390, hasTouch: true })).toBe('tablet')
  })

  it.each([[768, 1024], [600, 960], [800, 1280]])('a %ix%i portrait tablet is no phone', (w, h) => {
    expect(detectDisplayMode({ width: w, height: h, hasTouch: true })).toBe('tablet')
  })

  it.each([[1280, 800], [1920, 1080], [1024, 768]])('a %ix%i screen without touch stays desktop', (w, h) => {
    expect(detectDisplayMode({ width: w, height: h, hasTouch: false })).toBe('desktop')
  })
})

describe('phoneLayoutActive', () => {
  it('automatic: only a portrait phone', () => {
    expect(phoneLayoutActive('auto', { width: 390, height: 844 })).toBe(true)
    expect(phoneLayoutActive(null, { width: 390, height: 844 })).toBe(true)
    expect(phoneLayoutActive('auto', { width: 844, height: 390 })).toBe(false)
    expect(phoneLayoutActive('auto', { width: 1280, height: 800 })).toBe(false)
  })

  it('a forced mode wins', () => {
    expect(phoneLayoutActive('phone', { width: 1280, height: 800 })).toBe(true)
    expect(phoneLayoutActive('desktop', { width: 390, height: 844 })).toBe(false)
    expect(phoneLayoutActive('tablet', { width: 390, height: 844 })).toBe(false)
  })
})

describe('isPhoneScreen (not locked to landscape)', () => {
  it('by the short side of the screen, either way up', () => {
    expect(isPhoneScreen({ width: 390, height: 844 })).toBe(true)
    expect(isPhoneScreen({ width: 844, height: 390 })).toBe(true)
    expect(isPhoneScreen({ width: 800, height: 1280 })).toBe(false)
    expect(isPhoneScreen({ width: 1920, height: 1080 })).toBe(false)
    expect(isPhoneScreen(null)).toBe(false)
  })
})

describe('phoneLayoutKept / phoneHeldSideways (a phone turned sideways)', () => {
  const phone = { width: 390, height: 844 }
  const laptop = { width: 1920, height: 1080 }
  const tablet = { width: 800, height: 1280 }

  it('a phone in the automatic mode keeps the phone layout either way up', () => {
    expect(phoneLayoutKept('auto', { width: 390, height: 844 }, phone)).toBe(true)
    expect(phoneLayoutKept('auto', { width: 844, height: 390 }, phone)).toBe(true)
    expect(phoneHeldSideways('auto', { width: 390, height: 844 }, phone)).toBe(false)
    expect(phoneHeldSideways('auto', { width: 844, height: 390 }, phone)).toBe(true)
    expect(phoneHeldSideways(null, { width: 844, height: 390 }, { width: 844, height: 390 })).toBe(true)
  })

  it('tablets and computers are untouched, and so are forced modes', () => {
    expect(phoneLayoutKept('auto', { width: 1280, height: 800 }, tablet)).toBe(false)
    expect(phoneLayoutKept('auto', { width: 900, height: 500 }, laptop)).toBe(false)
    expect(phoneHeldSideways('auto', { width: 1366, height: 768 }, laptop)).toBe(false)
    expect(phoneLayoutKept('desktop', { width: 844, height: 390 }, phone)).toBe(false)
    expect(phoneLayoutKept('tablet', { width: 844, height: 390 }, phone)).toBe(false)
    // the Phone mode shows the phone layout itself, sideways too (no notice)
    expect(phoneLayoutKept('phone', { width: 844, height: 390 }, phone)).toBe(true)
    expect(phoneHeldSideways('phone', { width: 844, height: 390 }, phone)).toBe(false)
  })
})

describe('COURT_CELLS', () => {
  it('each half holds the six positions once', () => {
    for (const side of ['left', 'right']) {
      expect([...COURT_CELLS[side]].sort()).toEqual([...POSITIONS].sort())
    }
  })

  it('the server (I) is in the outer back corner, the front row at the net', () => {
    // 2 columns x 3 rows, reading order: left team's back row is column 0
    const col = (side, pos) => COURT_CELLS[side].indexOf(pos) % 2
    for (const pos of ['II', 'III', 'IV']) expect(col('left', pos)).toBe(1)
    for (const pos of ['I', 'V', 'VI']) expect(col('left', pos)).toBe(0)
    for (const pos of ['II', 'III', 'IV']) expect(col('right', pos)).toBe(0)
    for (const pos of ['I', 'V', 'VI']) expect(col('right', pos)).toBe(1)
    // both teams' position IV faces the other's II across the net
    const row = (side, pos) => Math.floor(COURT_CELLS[side].indexOf(pos) / 2)
    expect(row('left', 'IV')).toBe(row('right', 'II'))
    expect(row('left', 'II')).toBe(row('right', 'IV'))
  })
})

describe('recentActions', () => {
  const describe_ = (e) => (e.type === 'mystery' ? null : `${e.type} ${e.seq}`)
  const ev = (seq, type, payload = {}, setIndex = 2) => ({ id: seq * 10, seq, type, payload, setIndex, ts: seq })

  it('the newest main actions of the current set, newest first', () => {
    const events = [
      ev(1, 'point', {}, 1),
      ev(2, 'lineup', { isInitial: true }),
      ev(3, 'rally_start'),
      ev(4, 'point'),
      ev(4.1, 'lineup'),
      ev(5, 'timeout'),
      ev(6, 'replay'),
      ev(7, 'lineup'),
      ev(8, 'mystery'),
      ev(9, 'substitution'),
      ev(9.1, 'lineup', { fromSubstitution: true })
    ]
    expect(recentActions(events, 2, describe_).map(r => r.text)).toEqual(['substitution 9', 'timeout 5', 'point 4'])
    expect(recentActions(events, 2, describe_, 5).map(r => r.text)).toEqual(['substitution 9', 'timeout 5', 'point 4', 'lineup 2'])
  })

  it('nothing to show', () => {
    expect(recentActions([], 1, describe_)).toEqual([])
    expect(recentActions(null, 1, describe_)).toEqual([])
  })
})

describe('small helpers', () => {
  it('officialRoleShort', () => {
    expect(officialRoleShort('Coach')).toBe('C')
    expect(officialRoleShort('Assistant Coach 2')).toBe('AC2')
    expect(officialRoleShort('Medic')).toBe('M')
  })

  it('tintOf mixes a colour with white', () => {
    expect(tintOf('#000000', 0.1)).toBe('#e6e6e6')
    expect(tintOf('#ffffff', 0.5)).toBe('#ffffff')
    expect(tintOf('red')).toBeNull()
  })
})

describe('phone action grid labels (a 4-column grid on a 360px phone)', () => {
  // A word longer than its button broke anywhere ("eScoresh|eet",
  // "Wiederhole|n"): those labels carry a soft hyphen where they may break
  it('long labels break only at their soft hyphen, in every locale', async () => {
    const SHY = '­'
    for (const lang of ['en', 'de', 'de-CH', 'fr', 'it']) {
      const { default: locale } = await import(`../../../i18n/locales/${lang}.json`)
      const phone = locale.scoreboard.phone
      expect(phone.scoresheet, lang).toContain(SHY)
      // every word of 10+ letters among the grid labels has a break point
      for (const label of [phone.libero, locale.scoreboard.sanction, phone.replay, phone.decision, locale.scoreboard.rosters, phone.scoresheet]) {
        for (const word of label.split(/\s+/)) {
          if (word.replaceAll(SHY, '').length >= 10) expect(word, `${lang}: ${label}`).toContain(SHY)
        }
      }
    }
  })
})

describe('phone point buttons on a short screen (styles.css)', () => {
  // Browser bars or the Android app's system bars leave less height than the
  // phone has: the point buttons get lower there instead of pushing the
  // action grid off screen; square otherwise, and square without container units
  it('square by default, lower within the height left when container units exist', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const css = readFileSync(resolve(__dirname, '../../../styles.css'), 'utf8')
    const base = css.match(/\.phone-scoreboard \.phone-square \{([^}]*)\}/)
    expect(base?.[1]).toMatch(/aspect-ratio: 1 \/ 1/)
    const supports = css.match(/@supports \(height: 1cqh\) \{([\s\S]*?)\n\}/)?.[1] || ''
    expect(supports).toMatch(/\.phone-scoreboard \.phone-square \{[^}]*height: min\(\(100cqw - 34px\) \/ 2, max\(var\(--phone-square-min\), 100cqh - var\(--phone-square-reserve\)/)
  })
})

describe('phone layout on a short screen (styles.css)', () => {
  // The heights a phone page really gets (browser bars, the Android app's
  // system bars), less the folded app header's 16px bar. At 360x640 the
  // action grid ran 6px below the screen: the point buttons were at their
  // lowest and the 2:1 court did not give way. The point buttons get lower
  // down to their minimum, then the court gets lower down to its minimum.
  it.each([[360, 640], [390, 664], [360, 708]])('everything fits a %ix%i page without scrolling', (width, height) => {
    expect(PHONE_COURT_MIN_PX).toBeGreaterThan(0)
    expect(PHONE_SQUARE_RESERVE_PX + PHONE_COURT_MIN_PX + PHONE_SQUARE_MIN_PX).toBeLessThanOrEqual(height - 16)
    // the court is never taller than half its width (the 2:1 court)
    expect(PHONE_COURT_MIN_PX).toBeLessThanOrEqual((width - 24) / 2)
    // three rows of 28px shirt numbers still fit a court at its lowest
    // (2px borders, 6px padding top and bottom, two 2px gaps)
    expect((PHONE_COURT_MIN_PX - 4 - 12 - 4) / 3).toBeGreaterThanOrEqual(28)
  })

  it('the court gets lower before the point buttons scroll; square buttons and a 2:1 court otherwise', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const css = readFileSync(resolve(__dirname, '../../../styles.css'), 'utf8')
    expect(css).toMatch(/\.phone-scoreboard \.phone-court \{[^}]*aspect-ratio: 2 \/ 1/)
    expect(css).toMatch(/\.phone-scoreboard \.phone-square \{[^}]*aspect-ratio: 1 \/ 1/)
    const supports = css.match(/@supports \(height: 1cqh\) \{([\s\S]*?)\n\}/)?.[1] || ''
    const court = '(100cqw - 24px) / 2, max(var(--phone-court-min), 100cqh - var(--phone-square-reserve) - var(--phone-square-min))'
    expect(supports).toContain(`height: min(${court});`)
    expect(supports).toContain(`height: min((100cqw - 34px) / 2, max(var(--phone-square-min), 100cqh - var(--phone-square-reserve) - min(${court})));`)
  })
})
