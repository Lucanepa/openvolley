// The "10-minute interval after set 2" switch: no button padding (the global
// <button> padding in styles.css squeezed the thumb off the track when on),
// as MatchSetup's ToggleSwitch.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k) => k }) }))

const { default: LongIntervalSwitch } = await import('../LongIntervalSwitch')

afterEach(() => cleanup())

describe('LongIntervalSwitch', () => {
  it('renders the switch with p-0 (no button padding), on and off', () => {
    const onChange = vi.fn()
    const { getByTestId, rerender } = render(<LongIntervalSwitch checked={false} onChange={onChange} />)
    const sw = getByTestId('long-interval-after-set2-switch')
    expect(sw.getAttribute('role')).toBe('switch')
    expect(sw.className.split(/\s+/)).toContain('p-0')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
    rerender(<LongIntervalSwitch checked onChange={onChange} />)
    const on = getByTestId('long-interval-after-set2-switch')
    expect(on.className.split(/\s+/)).toContain('p-0')
    expect(on.getAttribute('aria-checked')).toBe('true')
  })
})
