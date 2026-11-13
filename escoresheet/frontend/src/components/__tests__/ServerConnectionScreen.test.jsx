import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// Mock dependencies before importing the component
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // the fallback text, else the key (also for interpolation options)
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}))

// The real address rules (isAllowedBackendUrl, the link server); the setter
// and the port lookup are watched
vi.mock('../../utils/backendConfig', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    setBackendOverride: vi.fn(actual.setBackendOverride),
    learnRelayWsPort: vi.fn(async () => null)
  }
})

vi.mock('html5-qrcode', () => ({
  Html5Qrcode: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn()
  }))
}))

import ServerConnectionScreen from '../ServerConnectionScreen'
import { learnRelayWsPort, setBackendOverride, getBackendOverride } from '../../utils/backendConfig'
import { setAppEntry } from '../../utils/appEntry'

describe('ServerConnectionScreen', () => {
  const mockOnConnected = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    setAppEntry(null)
    window.history.replaceState({}, '', '/')
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
    const store = setBackendOverride.getMockImplementation()
    setBackendOverride.mockImplementation((url) => { order.push('override'); store(url) })
    const onConnected = vi.fn(() => order.push('connected'))

    render(<ServerConnectionScreen onConnected={onConnected} />)
    fireEvent.change(screen.getByPlaceholderText(/192\.168/), { target: { value: '192.168.1.20:5173' } })
    fireEvent.click(screen.getByText('Connect'))

    await waitFor(() => expect(onConnected).toHaveBeenCalled())
    expect(learnRelayWsPort).toHaveBeenCalledWith('http://192.168.1.20:5173')
    expect(setBackendOverride).toHaveBeenCalledWith('http://192.168.1.20:5173')
    expect(order).toEqual(['learn', 'override', 'connected'])
  })

  // fe-secondary-apps-4: an address setBackendOverride drops (a plain host
  // name, a VPN or public address) answered /health, was shown as
  // "Connected!" and the page kept the default backend.
  it.each(['scorer-laptop:8080', '100.101.102.103:8080', 'https://example.com', 'http://backend.openvolley.app'])(
    'refuses %s before any request, and says why', async (address) => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true })
      render(<ServerConnectionScreen onConnected={mockOnConnected} />)
      fireEvent.change(screen.getByPlaceholderText(/192\.168/), { target: { value: address } })
      fireEvent.click(screen.getByText('Connect'))

      expect(await screen.findByText(/This address can't be used/)).toBeInTheDocument()
      expect(screen.queryByText('Connected!')).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
      expect(mockOnConnected).not.toHaveBeenCalled()
      expect(getBackendOverride()).toBeNull()
    }
  )

  it('a bare cloud name gets https:// (a plain-http cloud address is refused)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true })
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    fireEvent.change(screen.getByPlaceholderText(/192\.168/), { target: { value: 'backend.openvolley.app' } })
    fireEvent.click(screen.getByText('Connect'))

    await waitFor(() => expect(mockOnConnected).toHaveBeenCalledWith({ serverUrl: 'https://backend.openvolley.app' }))
    expect(global.fetch).toHaveBeenCalledWith('https://backend.openvolley.app/health', expect.objectContaining({ method: 'GET' }))
    expect(getBackendOverride()).toBe('https://backend.openvolley.app')
  })

  // fe-connect-devices-1: a role link's ?server= is used only after a
  // question that names the host, and only by this page in this tab
  it('?server= naming another server: asks first, naming the host, and fetches nothing before', async () => {
    setAppEntry('referee')
    window.history.replaceState({}, '', `/referee?server=${encodeURIComponent('http://192.168.1.66:8080')}&match=m1`)
    global.fetch = vi.fn().mockResolvedValue({ ok: true })
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)

    const card = await screen.findByTestId('link-server-confirm')
    expect(within(card).getByTestId('link-server-host').textContent).toBe('192.168.1.66:8080')
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockOnConnected).not.toHaveBeenCalled()
    expect(getBackendOverride()).toBeNull()

    fireEvent.click(within(card).getByRole('button', { name: 'Connect to this server' }))
    await waitFor(() => expect(mockOnConnected).toHaveBeenCalledWith({ serverUrl: 'http://192.168.1.66:8080' }))
    expect(global.fetch).toHaveBeenCalledWith('http://192.168.1.66:8080/health', expect.objectContaining({ method: 'GET' }))
    // this page in this tab only: not the device's setting the scorer reads
    expect(getBackendOverride()).toBe('http://192.168.1.66:8080')
    expect(setBackendOverride).not.toHaveBeenCalled()
    expect(localStorage.getItem('openvolley_backend_override')).toBeNull()
    setAppEntry('scorer')
    expect(getBackendOverride()).toBeNull()
  })

  // Review: a confirmed link server was also saved as "Last used"
  // (localStorage); a tap on it in a later tab went through
  // setBackendOverride, the setting the scorer page reads
  it('a confirmed link server is not offered as "Last used" later', async () => {
    setAppEntry('referee')
    window.history.replaceState({}, '', `/referee?server=${encodeURIComponent('http://192.168.1.66:8080')}`)
    global.fetch = vi.fn().mockResolvedValue({ ok: true })
    const { unmount } = render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    fireEvent.click(within(await screen.findByTestId('link-server-confirm')).getByRole('button', { name: 'Connect to this server' }))
    await waitFor(() => expect(mockOnConnected).toHaveBeenCalledWith({ serverUrl: 'http://192.168.1.66:8080' }))
    expect(localStorage.getItem('openvolley_last_server')).toBeNull()
    unmount()

    // a new tab on the same page, without the link
    sessionStorage.clear()
    window.history.replaceState({}, '', '/referee')
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    expect(screen.getByText('Online (automatic)')).toBeInTheDocument()
    expect(screen.queryByText(/Last used/)).toBeNull()
    expect(screen.queryByText(/192\.168\.1\.66/)).toBeNull()
    expect(localStorage.getItem('openvolley_backend_override')).toBeNull()
    setAppEntry('scorer')
    expect(getBackendOverride()).toBeNull()
  })

  it('a link server leaves the "Last used" server the user chose before', async () => {
    localStorage.setItem('openvolley_last_server', JSON.stringify({ url: 'http://192.168.1.30:8080', label: 'Local', timestamp: 1 }))
    setAppEntry('bench')
    window.history.replaceState({}, '', `/bench?server=${encodeURIComponent('http://192.168.1.66:8080')}`)
    global.fetch = vi.fn().mockResolvedValue({ ok: true })
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    fireEvent.click(within(await screen.findByTestId('link-server-confirm')).getByRole('button', { name: 'Connect to this server' }))
    await waitFor(() => expect(mockOnConnected).toHaveBeenCalled())
    expect(JSON.parse(localStorage.getItem('openvolley_last_server')).url).toBe('http://192.168.1.30:8080')
  })

  it('a server chosen on the screen is still offered as "Last used"', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true })
    const { unmount } = render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    fireEvent.change(screen.getByPlaceholderText(/192\.168/), { target: { value: '192.168.1.30:8080' } })
    fireEvent.click(screen.getByText('Connect'))
    await waitFor(() => expect(mockOnConnected).toHaveBeenCalled())
    unmount()
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    expect(await screen.findByText(/Last used/)).toBeInTheDocument()
  })

  it('?server= declined: the usual choices, nothing stored', async () => {
    setAppEntry('bench')
    window.history.replaceState({}, '', `/bench?server=${encodeURIComponent('https://x.openvolley.app')}`)
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)

    const card = await screen.findByTestId('link-server-confirm')
    expect(within(card).getByTestId('link-server-host').textContent).toBe('x.openvolley.app')
    fireEvent.click(within(card).getByRole('button', { name: 'Choose the server myself' }))
    expect(screen.queryByTestId('link-server-confirm')).toBeNull()
    expect(screen.getByText('Online (automatic)')).toBeInTheDocument()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(getBackendOverride()).toBeNull()
  })

  it('?server= naming a refused host: not even its /health, and says why', async () => {
    setAppEntry('referee')
    window.history.replaceState({}, '', '/referee?server=tracker.example.com')
    global.fetch = vi.fn().mockResolvedValue({ ok: true })
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)

    expect(await screen.findByText(/This address can't be used/)).toBeInTheDocument()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockOnConnected).not.toHaveBeenCalled()
    expect(getBackendOverride()).toBeNull()
  })

  it('?server= naming the page\'s own server connects at once', async () => {
    setAppEntry('livescore')
    // the dev server in the tests: the page's own origin is its default backend
    const own = `${window.location.protocol}//${window.location.host}`
    window.history.replaceState({}, '', `/livescore?server=${encodeURIComponent(own)}`)
    global.fetch = vi.fn().mockResolvedValue({ ok: true })
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)

    await waitFor(() => expect(mockOnConnected).toHaveBeenCalledWith({ serverUrl: own }))
    expect(screen.queryByTestId('link-server-confirm')).toBeNull()
    expect(setBackendOverride).not.toHaveBeenCalled()
  })

  // The tablets' first screen has the "?" too: the app's help, on Connecting tablets
  it.each(['referee', 'bench', 'livescore'])('%s: the "?" opens the app\'s help on Connecting tablets', (app) => {
    render(<ServerConnectionScreen onConnected={mockOnConnected} helpScreen={app} />)
    const panel = screen.getByTestId('help-panel')
    expect(panel.getAttribute('aria-modal')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Help' }))
    expect(panel.getAttribute('aria-modal')).toBe('true')
    const sections = [...panel.querySelectorAll('[data-testid^="help-section-"]')].map(n => n.dataset.testid.replace('help-section-', ''))
    expect(sections).toEqual([app, 'connections'])
    const expanded = (id) => panel.querySelector(`[data-testid="help-section-${id}"] button`).getAttribute('aria-expanded')
    expect(expanded('connections')).toBe('true')
    expect(expanded(app)).toBe('false')
    // the close button
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }))
    expect(panel.getAttribute('aria-modal')).toBeNull()
  })

  it('without a help screen: no "?" and no panel', () => {
    render(<ServerConnectionScreen onConnected={mockOnConnected} />)
    expect(screen.queryByRole('button', { name: 'Help' })).toBeNull()
    expect(screen.queryByTestId('help-panel')).toBeNull()
  })
})
