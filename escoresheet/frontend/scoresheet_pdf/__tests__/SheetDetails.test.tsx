import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { CircleLetter, CAP_HEIGHT_EM } from '../components/CircleLetter'
import { SetFive } from '../components/SetFive'
import { Sanctions } from '../components/FooterSection'

// Owner notes on a rebuilt PDF, 2026-11-16: the deciding set's right rule off
// set 4's line, IMPROPER REQUEST wrapped, Score too big, the letters high in
// their rings.

afterEach(cleanup)

describe('CircleLetter', () => {
  it('draws the letter as SVG text, its baseline half a cap height below the centre', () => {
    const { container } = render(<CircleLetter letter="A" size={10} fontPx={7} />)
    const text = container.querySelector('svg text') as SVGTextElement
    expect(text.textContent).toBe('A')
    expect(text.getAttribute('y')).toBe('50%')
    expect(Number(text.getAttribute('dy'))).toBeCloseTo(CAP_HEIGHT_EM * 7 / 2, 5)
    expect(text.getAttribute('text-anchor')).toBe('middle')
    // the ring keeps its size and is read as one letter (no hidden copy)
    const ring = container.firstElementChild as HTMLElement
    expect(ring.style.width).toBe('10px')
    expect(ring.textContent).toBe('A')
  })

  it('an empty ring has no text', () => {
    const { container } = render(<CircleLetter letter="" size={20} fontPx={10} />)
    expect(container.querySelector('svg')).toBeNull()
  })
})

describe('deciding set geometry', () => {
  it('panels 1-2 in one 150 mm box, panel 3 in one 75 mm box after the court change, its rule on the right', () => {
    const { getByTestId } = render(<SetFive teamNameA="AAA" teamNameB="BBB" />)
    const box = getByTestId('set5-box')
    const body = box.children[2] as HTMLElement // header strip, court change, body
    expect(body.children).toHaveLength(2)
    const [left, right] = Array.from(body.children) as HTMLElement[]
    expect(left.style.width).toBe('150mm')
    expect(right.style.width).toBe('75mm')
    expect(right.style.marginLeft).toBe('48px')
    // the header strip: the same two boxes
    const header = box.children[0] as HTMLElement
    const [hl, hr] = Array.from(header.children) as HTMLElement[]
    expect(hl.style.width).toBe('150mm')
    expect(hr.style.width).toBe('75mm')
    expect(hr.style.marginLeft).toBe('48px')
    // panel 3's points column draws the set's right rule
    const p3points = right.lastElementChild as HTMLElement
    expect(p3points.className).toMatch(/\bborder-r\b/)
  })
})

describe('SANCTIONS head', () => {
  it('IMPROPER REQUEST is one fitted line, Score is smaller than the other headings', () => {
    const { getByTestId } = render(<Sanctions />)
    const label = getByTestId('sanctions-improper-label')
    expect(label.style.whiteSpace).toBe('nowrap')
    expect(label.textContent).toBe('Improper Request')
    expect(getByTestId('sanctions-head-score').className).toMatch(/text-\[7\.5px\]/)
  })
})
