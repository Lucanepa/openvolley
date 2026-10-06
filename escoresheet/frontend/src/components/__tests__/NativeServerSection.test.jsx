import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => fallback || key })
}))

import NativeServerSection from '../options/NativeServerSection'

describe('NativeServerSection (Android app)', () => {
  beforeEach(() => {
    localStorage.clear()
    global.fetch = vi.fn()
  })
  afterEach(() => {
    delete window.Capacitor
  })

  it('renders nothing outside the native app', () => {
    const { container } = render(<NativeServerSection />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the cloud server by default and the LAN relay once one is chosen', () => {
    window.Capacitor = { isNativePlatform: () => true }
    const { unmount } = render(<NativeServerSection />)
    expect(screen.getByTestId('native-server-current')).toHaveTextContent('backend.openvolley.app')
    unmount()
    localStorage.setItem('openvolley_backend_override', 'http://192.168.1.20:8080')
    render(<NativeServerSection />)
    expect(screen.getByTestId('native-server-current')).toHaveTextContent('192.168.1.20:8080')
  })

  it('connects to a plain-http LAN relay typed by the user', async () => {
    window.Capacitor = { isNativePlatform: () => true }
    global.fetch.mockResolvedValue({ ok: true })
    const reload = vi.fn()
    const realLocation = window.location
    Object.defineProperty(window, 'location', { value: { ...realLocation, reload }, writable: true, configurable: true })
    try {
      render(<NativeServerSection />)
      fireEvent.click(screen.getByText('Change server'))
      fireEvent.change(screen.getByPlaceholderText(/192\.168/), { target: { value: '192.168.1.20:8080' } })
      fireEvent.click(screen.getByText('Connect'))
      await waitFor(() => expect(reload).toHaveBeenCalled())
      expect(global.fetch).toHaveBeenCalledWith('http://192.168.1.20:8080/health', expect.anything())
      expect(localStorage.getItem('openvolley_backend_override')).toBe('http://192.168.1.20:8080')
    } finally {
      Object.defineProperty(window, 'location', { value: realLocation, writable: true, configurable: true })
    }
  })
})
