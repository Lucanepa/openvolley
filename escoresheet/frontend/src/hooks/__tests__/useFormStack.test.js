import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFormStack } from '../useFormStack'
import { FORM_STACK_QUERY } from '../../utils/formLayout'

const realMatchMedia = window.matchMedia

function installMatchMedia(initial) {
  const listeners = new Set()
  const mq = {
    matches: initial,
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
  }
  window.matchMedia = vi.fn(() => mq)
  const turn = (matches) => act(() => { mq.matches = matches; listeners.forEach(fn => fn()) })
  return { turn, listeners }
}

afterEach(() => { window.matchMedia = realMatchMedia })

describe('useFormStack', () => {
  it('is false in landscape and follows the device as it turns', () => {
    const { turn, listeners } = installMatchMedia(false)
    const { result, unmount } = renderHook(() => useFormStack())
    expect(window.matchMedia).toHaveBeenCalledWith(FORM_STACK_QUERY)
    expect(result.current).toBe(false)
    turn(true)
    expect(result.current).toBe(true)
    turn(false)
    expect(result.current).toBe(false)
    unmount()
    expect(listeners.size).toBe(0)
  })

  it('is false without matchMedia', () => {
    window.matchMedia = undefined
    const { result } = renderHook(() => useFormStack())
    expect(result.current).toBe(false)
  })
})
