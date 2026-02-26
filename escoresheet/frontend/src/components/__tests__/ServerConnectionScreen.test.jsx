import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Mock dependencies before importing the component
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => fallback || key
  })
}))

vi.mock('../../utils/backendConfig', () => ({
  getBackendUrl: vi.fn(),
  getBackendOverride: vi.fn(),
  setBackendOverride: vi.fn(),
  clearBackendOverride: vi.fn()
}))

vi.mock('html5-qrcode', () => ({
  Html5Qrcode: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn()
  }))
}))

import ServerConnectionScreen from '../ServerConnectionScreen'

describe('ServerConnectionScreen', () => {
  const mockOnConnected = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    global.fetch = vi.fn()
  })

  it('renders the connection screen', () => {
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    expect(screen.getByText('Connect to Server')).toBeInTheDocument()
  })

  it('shows input field for server URL', () => {
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    const input = screen.getByPlaceholderText(/192\.168/)
    expect(input).toBeInTheDocument()
  })

  it('rejects javascript: protocol URLs', async () => {
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    const input = screen.getByPlaceholderText(/192\.168/)
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } })

    const connectBtn = screen.getByText('Connect')
    fireEvent.click(connectBtn)

    await waitFor(() => {
      expect(screen.getByText('Invalid server URL')).toBeInTheDocument()
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('rejects data: protocol URLs', async () => {
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    const input = screen.getByPlaceholderText(/192\.168/)
    fireEvent.change(input, { target: { value: 'data:text/html,<h1>hi</h1>' } })

    const connectBtn = screen.getByText('Connect')
    fireEvent.click(connectBtn)

    await waitFor(() => {
      expect(screen.getByText('Invalid server URL')).toBeInTheDocument()
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('accepts valid http URL and attempts connection', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true })

    render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    const input = screen.getByPlaceholderText(/192\.168/)
    fireEvent.change(input, { target: { value: '192.168.1.100:8080' } })

    const connectBtn = screen.getByText('Connect')
    fireEvent.click(connectBtn)

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        'http://192.168.1.100:8080/health',
        expect.objectContaining({ method: 'GET' })
      )
    })
  })

  it('accepts full URL with protocol', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true })

    render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    const input = screen.getByPlaceholderText(/192\.168/)
    fireEvent.change(input, { target: { value: 'https://backend.openvolley.app' } })

    const connectBtn = screen.getByText('Connect')
    fireEvent.click(connectBtn)

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        'https://backend.openvolley.app/health',
        expect.objectContaining({ method: 'GET' })
      )
    })
  })
})
