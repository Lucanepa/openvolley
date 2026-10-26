import { describe, it, expect } from 'vitest'
import { cutText, wellFormedText } from '../stringUtils'

// half of a surrogate pair: what html-to-image cannot serialise (encodeURIComponent
// throws "URI malformed"), so a name holding one made Save PDF fail
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('cutText', () => {
  it('keeps a text that fits, cuts a longer one at max UTF-16 units', () => {
    expect(cutText('Wiedikon', 60)).toBe('Wiedikon')
    expect(cutText('abcdef', 4)).toBe('abcd')
    expect(cutText('', 4)).toBe('')
    expect(cutText(null, 4)).toBe('')
  })

  it('never cuts an emoji in half: one unit fewer instead', () => {
    const name = `${'x'.repeat(59)}🏐 Damen`
    const cut = cutText(name, 60)
    expect(LONE.test(cut)).toBe(false)
    expect(cut).toBe('x'.repeat(59))
    expect(cutText(`${'x'.repeat(58)}🏐 Damen`, 60)).toBe(`${'x'.repeat(58)}🏐`)
    expect(cutText('A🏐🏐', 4)).toBe('A🏐')
  })
})

describe('wellFormedText', () => {
  it('replaces half an emoji by U+FFFD and keeps whole ones', () => {
    expect(wellFormedText('Damen 2 \ud83c')).toBe('Damen 2 �')
    expect(wellFormedText('\udc10x')).toBe('�x')
    expect(wellFormedText('🏐 Max')).toBe('🏐 Max')
    expect(wellFormedText('Zürich')).toBe('Zürich')
  })
})
