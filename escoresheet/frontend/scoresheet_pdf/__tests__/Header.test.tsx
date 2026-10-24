import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Header } from '../components/Header'

// The scoresheet window loads the scorer app's styles.css; its global input rule
// printed the empty 'other' header fields as dark filled boxes.
const APP_GLOBAL_INPUT_RULE = 'input { width: 100%; padding: 8px 10px; background: #0f172a; border-radius: 8px; color: #e2e8f0; }'

describe('Header "other" fields', () => {
  let style: HTMLStyleElement | null = null
  afterEach(() => {
    cleanup()
    style?.remove()
    style = null
  })

  it('stay white, unrounded fields even with the app\'s global input styles loaded', () => {
    style = document.createElement('style')
    style.textContent = APP_GLOBAL_INPUT_RULE
    document.head.appendChild(style)

    const { getByLabelText } = render(
      <Header match={{ championshipType: 'other', championshipTypeOther: 'Regio', match_type_3: 'other', match_type_3_other: 'U15' }} />
    )
    for (const label of ['Other championship type', 'Other age category']) {
      const input = getByLabelText(label) as HTMLInputElement
      const cs = getComputedStyle(input)
      expect(cs.backgroundColor).toBe('rgb(255, 255, 255)')
      expect(cs.color).toBe('rgb(0, 0, 0)')
      expect(cs.borderRadius).toBe('0px')
    }
    expect((getByLabelText('Other championship type') as HTMLInputElement).value).toBe('Regio')
    expect((getByLabelText('Other age category') as HTMLInputElement).value).toBe('U15')
  })
})

// owner 2026-10-24: the category boxes of a women's championship game
describe('Header category boxes', () => {
  afterEach(() => cleanup())
  const xd = (c: HTMLElement) => [...c.querySelectorAll('header span')]
    .filter(s => s.textContent === 'X')
    .map(s => s.parentElement?.nextElementSibling?.textContent || (s.parentElement?.nextElementSibling?.querySelector('input') as HTMLInputElement | null)?.value)

  it('X the match type, the championship type, the gender and the age box', () => {
    const { container } = render(<Header match={{ match_type_1: 'championship', championshipType: 'regional', match_type_2: 'women', match_type_3: 'U19' }} />)
    expect(xd(container)).toEqual(['Championship', 'Regional', 'Women', 'U19'])
  })

  it('senior has no box; an age without one (U21, U20) goes under Other with the age written', () => {
    const senior = render(<Header match={{ match_type_1: 'cup', match_type_2: 'men', match_type_3: 'senior' }} />)
    expect(xd(senior.container)).toEqual(['Cup', 'Men'])
    cleanup()
    const { container, getByLabelText } = render(<Header match={{ match_type_2: 'women', match_type_3: 'U21' }} />)
    expect(container.textContent).toContain('Women')
    expect((getByLabelText('Other age category') as HTMLInputElement).value).toBe('U21')
    expect(xd(container)).toHaveLength(2)
  })
})
