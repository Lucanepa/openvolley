import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => fallback || key
  })
}))

import TabletStatusIndicator from '../TabletStatusIndicator'

describe('TabletStatusIndicator', () => {
  // The scorer toggles referee/bench connections mid-match. Going from zero
  // enabled roles to one (and back) must not change the number of hooks the
  // component calls, or React throws and the scorer header unmounts.
  it('survives toggling the first/last connection on and off', () => {
    const off = { refereeConnectionEnabled: false, homeTeamConnectionEnabled: false, awayTeamConnectionEnabled: false }
    const on = { ...off, homeTeamConnectionEnabled: true }

    const { container, rerender } = render(<TabletStatusIndicator match={off} />)
    expect(container.firstChild).toBeNull()

    expect(() => rerender(<TabletStatusIndicator match={on} />)).not.toThrow()
    expect(container.querySelector('button')).not.toBeNull()

    expect(() => rerender(<TabletStatusIndicator match={off} />)).not.toThrow()
    expect(container.firstChild).toBeNull()
  })
})
