// The header's tablet chip asks the relay every 10 s. Under the Android
// in-app view (the scoresheet, a help page) nobody sees it: it stops asking
// there and asks again at once when the view closes (perf pass, 22.11.2026).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => fallback || key
  })
}))

const fetchRelayConnections = vi.hoisted(() => vi.fn(async () => ({ clients: [] })))
vi.mock('../../utils/serverDataSync', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchRelayConnections
}))

import TabletStatusIndicator from '../TabletStatusIndicator'
import { openAppWindow, currentInAppView } from '../../utils/openAppWindow'

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

beforeEach(() => {
  vi.useFakeTimers()
  fetchRelayConnections.mockClear()
})
afterEach(() => {
  currentInAppView()?.close()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('TabletStatusIndicator under the in-app view', () => {
  it('stops polling the relay while the view is open and polls at once when it closes', async () => {
    const match = { seed_key: 'match_1', refereeConnectionEnabled: true }
    render(<TabletStatusIndicator match={match} />)
    await act(flush)
    expect(fetchRelayConnections).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(10000) })
    expect(fetchRelayConnections).toHaveBeenCalledTimes(2)

    act(() => { openAppWindow('/scoresheet/?matchId=7', { win: window, platform: 'capacitor' }) })
    await act(async () => { vi.advanceTimersByTime(60000) })
    expect(fetchRelayConnections).toHaveBeenCalledTimes(2)
    // the chip is still there (paused, not disabled)
    expect(document.querySelector('button')).not.toBeNull()

    act(() => { currentInAppView().close() })
    await act(flush)
    expect(fetchRelayConnections).toHaveBeenCalledTimes(3)
    await act(async () => { vi.advanceTimersByTime(10000) })
    expect(fetchRelayConnections).toHaveBeenCalledTimes(4)
  })
})
