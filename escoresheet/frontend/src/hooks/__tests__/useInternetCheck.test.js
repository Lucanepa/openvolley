import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../utils/backendConfig', () => ({
  getCloudApiBaseUrl: vi.fn(() => 'https://backend.openvolley.app'),
  isLanBackendUrl: vi.fn((url) => /^http:\/\/(192\.168|10\.|localhost)/.test(String(url)))
}))

import { getCloudApiBaseUrl } from '../../utils/backendConfig'
import { useInternetCheck, internetCheckBaseUrl } from '../useInternetCheck'
import { TOTAL_BUDGET_MS } from '../../utils/internetCheck'

// The start check's "Internet" row is measured once each time the check
// opens, and the measurement ends when it closes (no more data fetched).

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

const baseUrl = () => 'https://backend.openvolley.app'

describe('useInternetCheck', () => {
  it('closed: nothing is measured', () => {
    const measure = vi.fn()
    const { result } = renderHook(() => useInternetCheck(false, { measure, baseUrl }))
    expect(result.current.status).toBe('unknown')
    expect(measure).not.toHaveBeenCalled()
  })

  it('open: measures once to the cloud server, then shows the result', async () => {
    let finish
    const measure = vi.fn(() => new Promise((resolve) => { finish = resolve }))
    const { result } = renderHook(() => useInternetCheck(true, { measure, baseUrl }))
    expect(result.current.status).toBe('connecting')
    await act(async () => {})
    expect(measure).toHaveBeenCalledTimes(1)
    expect(measure.mock.calls[0][0].baseUrl).toBe('https://backend.openvolley.app')
    await act(async () => { finish({ status: 'good', rttMs: 38, mbps: 24 }) })
    expect(result.current).toMatchObject({ status: 'good', rttMs: 38, mbps: 24 })
  })

  it('closed while measuring: the measurement is aborted and its late result ignored', async () => {
    let finish
    const measure = vi.fn(() => new Promise((resolve) => { finish = resolve }))
    const { result, rerender } = renderHook(({ open }) => useInternetCheck(open, { measure, baseUrl }), { initialProps: { open: true } })
    await act(async () => {})
    const { signal } = measure.mock.calls[0][0]
    expect(signal.aborted).toBe(false)
    rerender({ open: false })
    expect(signal.aborted).toBe(true)
    await act(async () => { finish({ status: 'slow', rttMs: 900 }) })
    expect(result.current.status).toBe('connecting')
  })

  it('opened again (offline mode switched off): measured again', async () => {
    const measure = vi.fn(async () => ({ status: 'good', rttMs: 40, mbps: 10 }))
    const { rerender } = renderHook(({ open }) => useInternetCheck(open, { measure, baseUrl }), { initialProps: { open: true } })
    await act(async () => {})
    rerender({ open: false })
    rerender({ open: true })
    await act(async () => {})
    expect(measure).toHaveBeenCalledTimes(2)
  })

  it('a measurement that never ends reads not measured, so the dialog never waits on it', async () => {
    vi.useFakeTimers()
    const measure = vi.fn(() => new Promise(() => {}))
    const { result } = renderHook(() => useInternetCheck(true, { measure, baseUrl }))
    await act(async () => { await vi.advanceTimersByTimeAsync(TOTAL_BUDGET_MS + 2000) })
    expect(result.current.status).toBe('not_checked')
    expect(measure.mock.calls[0][0].signal.aborted).toBe(true)
  })

  it('a measurement that throws reads not measured', async () => {
    const measure = vi.fn(async () => { throw new Error('boom') })
    const { result } = renderHook(() => useInternetCheck(true, { measure, baseUrl }))
    await act(async () => {})
    expect(result.current.status).toBe('not_checked')
  })
})

describe('internetCheckBaseUrl', () => {
  it('the cloud API server', () => {
    getCloudApiBaseUrl.mockReturnValue('https://backend.openvolley.app')
    expect(internetCheckBaseUrl()).toBe('https://backend.openvolley.app')
  })

  it('none on a page without cloud, or whose "cloud" is a server on the hall network', () => {
    getCloudApiBaseUrl.mockReturnValue(null)
    expect(internetCheckBaseUrl()).toBeNull()
    getCloudApiBaseUrl.mockReturnValue('http://192.168.1.20:5173')
    expect(internetCheckBaseUrl()).toBeNull()
  })
})
