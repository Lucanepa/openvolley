import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, d) => (typeof d === 'string' ? d : d?.defaultValue || k) })
}))

import EasyMatchModal from '../EasyMatchModal'

describe('EasyMatchModal', () => {
  it('cuts a long name before an emoji, never through it (half an emoji made Save PDF fail)', () => {
    const { container } = render(<EasyMatchModal open onCancel={() => {}} onStart={() => {}} />)
    const name = container.ownerDocument.getElementById('easy-home-name')
    fireEvent.change(name, { target: { value: 'Volleyballclub Schaffhausen-Neuhausen am Rheinfall Damen 2 🏐' } })
    expect(name.value).toBe('Volleyballclub Schaffhausen-Neuhausen am Rheinfall Damen 2 ')
    const short = container.ownerDocument.getElementById('easy-home-short')
    fireEvent.change(short, { target: { value: 'vbcshaf🏐' } })
    expect(short.value).toBe('VBCSHAF')
  })
})
