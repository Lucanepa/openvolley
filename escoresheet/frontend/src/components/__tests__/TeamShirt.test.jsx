import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import TeamShirt, { shirtEdge } from '../TeamShirt'
import { contrastRatio, readableTextOn } from '../../utils/teamColours'

function parts(container) {
  const shirt = container.querySelector('.shirt')
  return {
    shirt,
    body: shirt.querySelector('[data-part="body"]'),
    outline: shirt.querySelector('[data-part="outline"]'),
    number: shirt.querySelector('.number')
  }
}

describe('team shirt', () => {
  it('a white shirt has a grey outline that stands off the white card, and a dark number', () => {
    const { container } = render(<TeamShirt color="#FFFFFF" />)
    const { body, outline, number } = parts(container)
    expect(body.getAttribute('fill')).toBe('#ffffff')
    const stroke = outline.getAttribute('stroke')
    expect(stroke).toMatch(/^#[0-9a-f]{6}$/)
    expect(stroke).not.toBe('#ffffff')
    expect(contrastRatio(stroke, '#ffffff')).toBeGreaterThanOrEqual(3)
    expect(Number(outline.getAttribute('stroke-width'))).toBeGreaterThanOrEqual(1.5)
    expect(number.textContent).toBe('1')
    expect(number.style.color).toBe('rgb(28, 25, 23)') // TEXT_DARK
  })

  it('a black shirt keeps a black fill, a dark outline and a white number', () => {
    const { container } = render(<TeamShirt color="#000000" />)
    const { body, outline, number } = parts(container)
    expect(body.getAttribute('fill')).toBe('#000000')
    expect(contrastRatio(outline.getAttribute('stroke'), '#ffffff')).toBeGreaterThanOrEqual(3)
    expect(number.style.color).toBe('rgb(255, 255, 255)')
  })

  it('every picker colour gets a visible outline', () => {
    for (const c of ['#FFFFFF', '#000000', '#808080', '#dc2626', '#f97316', '#eab308', '#22c55e', '#065f46', '#3b82f6', '#1e3a8a', '#a855f7', '#ec4899']) {
      const edge = shirtEdge(c)
      expect(contrastRatio(edge, '#ffffff'), c).toBeGreaterThanOrEqual(3)
      // a shade of the fill, never lighter than it
      expect(contrastRatio(edge, '#ffffff'), c).toBeGreaterThanOrEqual(contrastRatio(c, '#ffffff'))
    }
    expect(shirtEdge('not a colour')).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('takes the caller number colour, keeps the box, the style and the click', () => {
    let clicked = 0
    const { container } = render(
      <TeamShirt color="#eab308" number={7} numberColor="#000000" style={{ transform: 'scale(0.8)' }} onClick={() => { clicked++ }} />
    )
    const { shirt, number } = parts(container)
    expect(shirt.style.transform).toBe('scale(0.8)')
    expect(number.textContent).toBe('7')
    expect(number.style.color).toBe('rgb(0, 0, 0)')
    shirt.click()
    expect(clicked).toBe(1)
    // the drawing is decoration; the number stays readable text
    expect(shirt.querySelector('svg').getAttribute('aria-hidden')).toBe('true')
  })

  it('defaults the number colour to the readable one on the fill', () => {
    const { container } = render(<TeamShirt color="#1e3a8a" />)
    expect(parts(container).number.style.color).toBe(readableTextOn('#1e3a8a') === '#ffffff' ? 'rgb(255, 255, 255)' : 'rgb(28, 25, 23)')
  })
})
