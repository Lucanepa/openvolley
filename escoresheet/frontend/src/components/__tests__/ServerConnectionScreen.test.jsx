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
  clearBackendOverride: vi.fn(),
  learnRelayWsPort: vi.fn(async () => null)
}))

vi.mock('html5-qrcode', () => ({
  Html5Qrcode: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn()
  }))
}))

import ServerConnectionScreen from '../ServerConnectionScreen'
import { learnRelayWsPort, setBackendOverride } from '../../utils/backendConfig'

describe('ServerConnectionScreen', () => {
  const mockOnConnected = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    global.fetch = vi.fn()
  })

  it('renders the connection screen', () => {
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    expect(screen.getByText('Connect to server')).toBeInTheDocument()
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

  // A desktop relay serves the page on 5173 and the WebSocket on 8080: the
  // screen asks the relay for its WebSocket port before the views connect.
  it('learns the relay WebSocket port before storing the server', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true })
    const order = []
    learnRelayWsPort.mockImplementation(async () => { order.push('learn'); return '8080' })
    setBackendOverride.mockImplementation(() => { order.push('override') })
    const onConnected = vi.fn(() => order.push('connected'))

    render(<ServerConnectionScreen onConnected={onConnected} />)
    fireEvent.change(screen.getByPlaceholderText(/192\.168/), { target: { value: '192.168.1.20:5173' } })
    fireEvent.click(screen.getByText('Connect'))

    await waitFor(() => expect(onConnected).toHaveBeenCalled())
    expect(learnRelayWsPort).toHaveBeenCalledWith('http://192.168.1.20:5173')
    expect(setBackendOverride).toHaveBeenCalledWith('http://192.168.1.20:5173')
    expect(order).toEqual(['learn', 'override', 'connected'])
  })
})
