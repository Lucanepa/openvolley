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
