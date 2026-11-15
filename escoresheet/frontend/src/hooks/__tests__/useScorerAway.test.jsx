import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useScorerAway, SCORER_AWAY_MS } from '../useScorerAway'

afterEach(() => vi.useRealTimers())

describe('useScorerAway', () => {
  it('warns only after the scorer is reported gone for 20 s without a break', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ p }) => useScorerAway(p), { initialProps: { p: null } })
    expect(result.current).toBe(false)
    rerender({ p: false })
    act(() => { vi.advanceTimersByTime(SCORER_AWAY_MS - 1) })
    expect(result.current).toBe(false)
    // back within the delay (a reload, a short dropout): nothing
    rerender({ p: true })
    rerender({ p: false })
    act(() => { vi.advanceTimersByTime(SCORER_AWAY_MS - 1) })
    expect(result.current).toBe(false)
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current).toBe(true)
    // the scorer is back: the warning goes at once
    rerender({ p: true })
    expect(result.current).toBe(false)
  })

  it('never warns while unknown (an older relay) or when disabled', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ p, enabled }) => useScorerAway(p, { enabled }), { initialProps: { p: null, enabled: true } })
    act(() => { vi.advanceTimersByTime(SCORER_AWAY_MS * 3) })
    expect(result.current).toBe(false)
    rerender({ p: false, enabled: false })
    act(() => { vi.advanceTimersByTime(SCORER_AWAY_MS * 3) })
    expect(result.current).toBe(false)
  })
})
