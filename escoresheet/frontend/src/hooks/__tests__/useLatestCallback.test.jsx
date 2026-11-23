// useLatestCallback: one identity for the component's life, and always the
// newest closure, also for a child's passive effect in the same commit (the
// Scoreboard's "already finished" effect calls App's onFinishSet).
import { describe, it, expect } from 'vitest'
import { useEffect, useState } from 'react'
import { render, renderHook, act } from '@testing-library/react'
import { useLatestCallback } from '../useLatestCallback'

describe('useLatestCallback', () => {
  it('keeps one identity across renders and calls the newest function', () => {
    const { result, rerender } = renderHook(({ n }) => useLatestCallback((x) => `${n}:${x}`), { initialProps: { n: 1 } })
    const first = result.current
    expect(first('a')).toBe('1:a')
    rerender({ n: 2 })
    expect(result.current).toBe(first)
    expect(first('b')).toBe('2:b')
  })

  it("a child's passive effect sees the parent's newest closure of the same commit", () => {
    const seen = []
    function Child({ onValue, value }) {
      useEffect(() => { seen.push(onValue()) }, [onValue, value])
      return null
    }
    let bump
    function Parent() {
      const [value, setValue] = useState(0)
      bump = () => setValue(v => v + 1)
      const onValue = useLatestCallback(() => value)
      return <Child onValue={onValue} value={value} />
    }
    render(<Parent />)
    act(() => bump())
    act(() => bump())
    expect(seen).toEqual([0, 1, 2])
  })
})
