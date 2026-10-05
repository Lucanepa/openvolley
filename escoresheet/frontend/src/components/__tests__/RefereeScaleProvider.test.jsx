import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { useScaledLayout } from '../../hooks/useScaledLayout'

function Probe() {
  const { vmin } = useScaledLayout()
  return <span data-testid="vmin">{typeof vmin}</span>
}

describe('referee entry ScaleProvider', () => {
  it('useScaledLayout throws without a ScaleProvider', () => {
    expect(() => render(<Probe />)).toThrow(/ScaleProvider/)
  })

  it('useScaledLayout works inside a ScaleProvider', () => {
    const { getByTestId } = render(<ScaleProvider><Probe /></ScaleProvider>)
    expect(getByTestId('vmin').textContent).toBe('function')
  })

  // Referee.jsx calls useScaledLayout(), so the referee entry must mount the provider.
  it('referee-main.jsx wraps RefereeApp in ScaleProvider', () => {
    const src = readFileSync(resolve(__dirname, '../../referee-main.jsx'), 'utf8')
    expect(src).toMatch(/<ScaleProvider>[\s\S]*<RefereeApp \/>[\s\S]*<\/ScaleProvider>/)
  })
})
