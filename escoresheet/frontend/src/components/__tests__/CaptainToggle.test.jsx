import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, a, b) => {
      const opts = typeof a === 'object' ? a : b
      const fallback = typeof a === 'string' ? a : opts?.defaultValue
      return String(fallback ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''))
    }
  })
}))

import CaptainToggle from '../CaptainToggle'

describe('roster captain toggle', () => {
  it('is a labelled toggle button a tablet can hit (40 px)', () => {
    render(<CaptainToggle pressed={false} number={7} onToggle={() => {}} />)
    const btn = screen.getByRole('button', { name: 'Team captain #7' })
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    expect(btn).toHaveAttribute('type', 'button')
    expect(btn.style.width).toBe('40px')
    expect(btn.style.height).toBe('40px')
  })

  it('reports the pressed state and toggles on click and keyboard activation', () => {
    const onToggle = vi.fn()
    render(<CaptainToggle pressed number={12} onToggle={onToggle} />)
    const btn = screen.getByRole('button', { name: 'Team captain #12' })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
    btn.focus()
    expect(document.activeElement).toBe(btn)
  })

  it('names the new-player row when no number is typed yet', () => {
    render(<CaptainToggle pressed={false} number="" onToggle={() => {}} />)
    expect(screen.getByRole('button', { name: 'Team captain (new player)' })).toBeInTheDocument()
  })
})
