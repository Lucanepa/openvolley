import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import PlayerDisc from '../referee/PlayerDisc.jsx'

const full = {
  number: 88,
  position: 'III',
  capPx: 93,
  side: 'right',
  background: '#333',
  color: '#fff',
  showBall: true,
  replacedNumber: 14,
  liberoLabel: 'L1',
  captain: 'GC',
  sanctions: { warning: true, penalty: true, expulsion: true },
  lfp: false
}

const SIZE_PROPS = ['width', 'height', 'minWidth', 'fontSize', 'top', 'left', 'right', 'bottom', 'padding', 'gap']

// Every length on a disc must be a share of the disc diameter (or 0 / a hairline),
// never the viewport: that is what let numbers, badges and the ball outgrow it.
function lengthsOf(el) {
  const out = []
  for (const node of [el, ...el.querySelectorAll('*')]) {
    for (const p of SIZE_PROPS) {
      const v = node.style[p]
      if (v) out.push([node.getAttribute('data-disc-badge') || node.tagName.toLowerCase(), p, v])
    }
  }
  return out
}

describe('referee PlayerDisc', () => {
  it('sizes the disc, number, badges, cards and ball from --disc only', () => {
    const { container } = render(<PlayerDisc {...full} />)
    const disc = container.querySelector('[data-player-disc="III"]')
    expect(disc).not.toBeNull()
    expect(disc.style.getPropertyValue('--disc')).toMatch(/^min\(26cqh, 15\.5cqw, 93px\)$/)
    for (const [who, prop, value] of lengthsOf(disc)) {
      expect(value, `${who} ${prop}`).not.toMatch(/vw|vh|vmin|vmax|rem/)
    }
    expect(disc.style.fontSize).toBe('var(--disc-number)')
    expect(disc.querySelector('[data-disc-ball]').style.width).toBe('var(--disc-ball)')
  })

  it('keeps every badge inside the disc box (no negative offsets)', () => {
    const { container } = render(<PlayerDisc {...full} />)
    const badges = container.querySelectorAll('[data-disc-badge]')
    expect([...badges].map(b => b.getAttribute('data-disc-badge')).sort()).toEqual(['captain', 'lfp', 'libero', 'position', 'replaced', 'sanctions'])
    for (const b of badges) {
      for (const p of ['top', 'left', 'right', 'bottom']) {
        expect(b.style[p], `${b.getAttribute('data-disc-badge')} ${p}`).not.toMatch(/^-/)
      }
    }
  })

  it('puts the serve ball on the end-line side', () => {
    const right = render(<PlayerDisc {...full} side="right" />).container.querySelector('[data-disc-ball]')
    expect(right.style.left).toBe('calc(100% + var(--disc-ball-gap))')
    const left = render(<PlayerDisc {...full} side="left" />).container.querySelector('[data-disc-ball]')
    expect(left.style.right).toBe('calc(100% + var(--disc-ball-gap))')
  })

  it('shows a redesignated libero as LR (the old code threw on an undefined R)', () => {
    const { container } = render(<PlayerDisc {...full} captain={null} liberoLabel="L" liberoRedesignated />)
    expect(container.querySelector('[data-disc-badge="libero"]').textContent).toBe('LR')
  })

  it('shows LC instead of the L badge for a libero captain', () => {
    const { container } = render(<PlayerDisc {...full} liberoLabel="L" captain="LC" />)
    expect(container.querySelector('[data-disc-badge="libero"]')).toBeNull()
    expect(container.querySelector('[data-disc-badge="captain"]').textContent).toBe('LC')
  })

  it('writes LC at the size of the other marks (the badge widens, the text does not shrink)', () => {
    const { container } = render(<PlayerDisc {...full} liberoLabel="L" captain="LC" />)
    const lc = container.querySelector('[data-disc-badge="captain"]')
    const pos = container.querySelector('[data-disc-badge="position"]')
    expect(lc.style.fontSize).toBe(pos.style.fontSize)
    expect(lc.style.width).toBe('')
  })

  it('fits LC (or LR) and all three sanction cards side by side on the smallest disc', () => {
    // 36 px disc (DISC.minPx), 1 px border: 34 px inside; badges are 11 px (badgeMinPx)
    const badge = 11
    const share = (v) => Number(String(v).match(/\*\s*([\d.]+)\)/)[1]) * badge
    const { container } = render(<PlayerDisc {...full} liberoLabel="L" captain="LC" sanctions={{ warning: true, penalty: true, expulsion: true }} />)
    const lc = container.querySelector('[data-disc-badge="captain"]')
    const cards = container.querySelector('[data-disc-badge="sanctions"]')
    // two bold capitals at 0.6 of the badge are at most 1.4 em wide (Inter bold LC measures 1.32 em); 2 px border each side
    const lcWidth = 1.4 * share(lc.style.fontSize) + 2 * share(lc.style.padding) + 4
    const leaves = [...cards.querySelectorAll('span[style*="background"]')].map(c => share(c.style.width))
    const groups = cards.children.length
    const cardsWidth = leaves.reduce((a, b) => a + b, 0) + 1 + (groups - 1) * share(cards.style.gap) + 2 * share(cards.style.padding)
    expect(lcWidth + cardsWidth).toBeLessThanOrEqual(34)
  })

  it('the referee court draws its players with PlayerDisc', () => {
    const src = readFileSync(resolve(__dirname, '../Referee.jsx'), 'utf8')
    expect(src).toMatch(/<PlayerDisc\b/)
    expect(src).toMatch(/containerType: 'size'/)
    expect(src).not.toMatch(/\{isRedesignated && R\}/)
  })
})
