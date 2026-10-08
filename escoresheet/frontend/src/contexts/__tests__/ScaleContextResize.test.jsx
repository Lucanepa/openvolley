// Laptop run of 2026-10-08 (OV-5): a window resize painted the scoreboard
// in up to three steps (court 1036x471 -> 793x360 -> 815x371 on a maximize):
// the CSS layout at once, the viewport state one task after the animation
// frame that read it, --vmin-base after a paint (useEffect). The frame that
// reads the new size commits it, with the CSS variables, before it paints.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ScaleProvider, useScale } from '../ScaleContext'

function Probe() {
  const { viewportVmin } = useScale()
  return <div data-testid="vmin">{viewportVmin}</div>
}

let frames
let previousAct
beforeEach(() => {
  previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1400 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 853 })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct
})

describe('ScaleProvider: a resize is one paint', () => {
  it('the frame that reads the new size shows it, CSS variables included', async () => {
    const { getByTestId } = render(<ScaleProvider><Probe /></ScaleProvider>)
    await new Promise(r => setTimeout(r, 0))
    expect(getByTestId('vmin').textContent).toBe('853')
    expect(document.documentElement.style.getPropertyValue('--vmin-base')).toBe('853px')

    window.innerWidth = 1694
    window.innerHeight = 1000
    window.dispatchEvent(new Event('resize'))
    expect(frames).toHaveLength(1)
    frames.shift()(performance.now())
    // synchronously, inside that frame (before the browser paints it)
    expect(getByTestId('vmin').textContent).toBe('1000')
    expect(document.documentElement.style.getPropertyValue('--vmin-base')).toBe('1000px')
  })
})
