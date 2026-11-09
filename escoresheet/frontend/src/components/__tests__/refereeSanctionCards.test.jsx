import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { CardGlyph, TeamSanctionList, topSanction, cardOfSanctionType, glyphWidthShare, CARD_ASPECT, CARD_YELLOW, CARD_RED } from '../referee/SanctionCards.jsx'

// The cards the referee holds up (rule 21.3), the same on the referee discs,
// the referee's sanctions strip and the bench tablet.

const t = (_k, fallback) => fallback
const bg = (el) => el.style.background
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})` }

describe('sanction card glyphs', () => {
  it('yellow, red, red and yellow together, red and yellow apart; real card proportions', () => {
    const one = (kind) => render(<CardGlyph kind={kind} height="30px" />).container.querySelector('[data-card-glyph]')
    expect(bg(one('warning'))).toBe(rgb(CARD_YELLOW))
    expect(bg(one('penalty'))).toBe(rgb(CARD_RED))
    expect([...one('expulsion').children].map(bg)).toEqual([rgb(CARD_YELLOW), rgb(CARD_RED)])
    expect([...one('disqualification').children].map(bg)).toEqual([rgb(CARD_YELLOW), rgb(CARD_RED)])
    expect(parseFloat(one('warning').style.width.replace('calc(', ''))).toBeCloseTo(30 * CARD_ASPECT, 1)
    // the pair in one hand overlaps, the two apart need more room
    expect(glyphWidthShare('expulsion')).toBeLessThan(glyphWidthShare('disqualification'))
    expect(one('penalty').getAttribute('aria-label')).toBe('Penalty')
  })

  it('the most severe on the scale, and stored types to cards', () => {
    expect(topSanction({})).toBeNull()
    expect(topSanction({ warning: true, penalty: true })).toBe('penalty')
    expect(topSanction({ disqualification: true, warning: true })).toBe('disqualification')
    expect(cardOfSanctionType('delay_warning')).toEqual({ kind: 'warning', delay: true })
    expect(cardOfSanctionType('delay_penalty')).toEqual({ kind: 'penalty', delay: true })
    expect(cardOfSanctionType('improper_request')).toEqual({ kind: null, improperRequest: true })
    expect(cardOfSanctionType('expulsion')).toEqual({ kind: 'expulsion' })
    expect(cardOfSanctionType('nonsense')).toBeNull()
  })

  it('a team\'s list: its state, then each card with who got it, delays marked D', () => {
    const { container } = render(<TeamSanctionList t={t} sanctions={{
      formalWarning: true, improperRequest: true, delayWarning: true, delayPenalty: false,
      warnings: [{ id: 7 }], penalties: [{ id: 'C' }], expulsions: [], disqualifications: [{ id: 12 }]
    }} />)
    expect(container.querySelector('[data-team-state="formal-warning"]').textContent).toBe('Formal warning')
    expect(container.querySelector('[data-team-state="improper-request"]').textContent).toBe('Improper request')
    const items = [...container.querySelectorAll('[data-sanction-item]')].map(li => [li.getAttribute('data-sanction-item'), li.textContent])
    expect(items).toEqual([['warning', '7'], ['penalty', 'C'], ['disqualification', '12'], ['delay-warning', 'D']])
    expect(container.querySelector('[data-sanction-item="delay-warning"]').title).toBe('Delay warning')
  })

  it('no sanctions: a dash', () => {
    const { container } = render(<TeamSanctionList t={t} sanctions={{ warnings: [], penalties: [], expulsions: [], disqualifications: [] }} />)
    expect(container.textContent).toBe('–')
  })
})
