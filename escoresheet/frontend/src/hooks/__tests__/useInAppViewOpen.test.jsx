import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { openAppWindow, currentInAppView } from '../../utils/openAppWindow'
import { useInAppViewOpen } from '../useInAppViewOpen'

afterEach(() => {
  currentInAppView()?.close()
  document.body.innerHTML = ''
})

describe('useInAppViewOpen', () => {
  it('follows the Android in-app view: open, another page in it, closed', () => {
    const { result } = renderHook(() => useInAppViewOpen())
    expect(result.current).toBe(false)
    act(() => { openAppWindow('/scoresheet/?matchId=7', { win: window, platform: 'capacitor' }) })
    expect(result.current).toBe(true)
    act(() => { openAppWindow('/scoresheet/?matchId=7&action=save', { win: window, platform: 'capacitor' }) })
    expect(result.current).toBe(true)
    act(() => { document.querySelector('[data-testid="app-window-back"]').click() })
    expect(result.current).toBe(false)
  })

  it('starts true under a view already open', () => {
    openAppWindow('/scoresheet/?matchId=7', { win: window, platform: 'capacitor' })
    const { result } = renderHook(() => useInAppViewOpen())
    expect(result.current).toBe(true)
  })
})
