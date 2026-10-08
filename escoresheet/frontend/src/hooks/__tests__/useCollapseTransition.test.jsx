// Laptop run of 2026-10-08 (OV-22): app scale 100 -> 125 %: the court
// rescaled at once, the header animated 40 -> 50 px (transition: all 0.3s)
// and moved the page under it for 0.3 s. The header animates only when it
// collapses or expands.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCollapseTransition, COLLAPSE_TRANSITION } from '../useCollapseTransition'

afterEach(() => vi.useRealTimers())

describe('useCollapseTransition', () => {
  it('no transition on other changes (an app scale), one while collapsing or expanding', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ collapsed, scale }) => useCollapseTransition(collapsed) + '|' + scale, { initialProps: { collapsed: false, scale: 1 } })
    expect(result.current).toBe('none|1')
    rerender({ collapsed: false, scale: 1.25 })
    expect(result.current).toBe('none|1.25')

    rerender({ collapsed: true, scale: 1.25 })
    expect(result.current).toBe(`${COLLAPSE_TRANSITION}|1.25`)
    act(() => { vi.advanceTimersByTime(200) })
    rerender({ collapsed: true, scale: 1.25 })
    expect(result.current).toBe(`${COLLAPSE_TRANSITION}|1.25`)
    // over: off again without any other render
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current).toBe('none|1.25')

    rerender({ collapsed: false, scale: 1 })
    expect(result.current).toBe(`${COLLAPSE_TRANSITION}|1`)
  })
})

describe('MainHeader', () => {
  it('takes its transition from useCollapseTransition (no permanent "all 0.3s")', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, '../../components/MainHeader.jsx'), 'utf8')
    expect(src).toContain('const headerTransition = useCollapseTransition(effectivelyCollapsed)')
    expect(src).toContain('transition: headerTransition,')
    expect(src).not.toContain("transition: 'all 0.3s ease-in-out',")
  })
})
