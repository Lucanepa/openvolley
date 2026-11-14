// @vitest-environment-options {"url": "http://scorer-laptop:5173/livescore/"}
// A page a venue relay serves on an address the allow-list does not cover (a
// plain host name here; an IPv6 or 100.64/10 hall address alike): "Online
// (automatic)" and a link naming that relay are the page's own server. The
// isAllowedBackendUrl guard refused them, with no request, and the tablet was
// stuck on the connection screen until a reload.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}))

vi.mock('../../utils/backendConfig', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    setBackendOverride: vi.fn(actual.setBackendOverride),
    learnRelayWsPort: vi.fn(async () => null)
  }
})

import ServerConnectionScreen from '../ServerConnectionScreen'
import { getBackendUrl, getBackendOverride, getRelayWebSocketUrl, setBackendOverride } from '../../utils/backendConfig'
import { setAppEntry } from '../../utils/appEntry'

const OWN = 'http://scorer-laptop:5173'

describe('ServerConnectionScreen on a page a relay serves on a plain host name', () => {
  const onConnected = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    // a built page (not the dev server): its backend is the relay serving it
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_BACKEND_URL', '')
    localStorage.clear()
    sessionStorage.clear()
    setAppEntry('livescore')
    window.history.replaceState({}, '', '/livescore/')
    global.fetch = vi.fn().mockResolvedValue({ ok: true })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    setAppEntry(null)
  })

  it('"Online (automatic)" connects to the page\'s own server', async () => {
    expect(getBackendUrl()).toBe(OWN)
    render(<ServerConnectionScreen onConnected={onConnected} />)
    fireEvent.click(screen.getByText('Online (automatic)'))

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith({ serverUrl: OWN }))
    expect(screen.queryByText(/This address can't be used/)).toBeNull()
    expect(global.fetch).toHaveBeenCalledWith(`${OWN}/health`, expect.objectContaining({ method: 'GET' }))
    // nothing stored: the page uses its own server with no override
    expect(setBackendOverride).not.toHaveBeenCalled()
    expect(getBackendOverride()).toBeNull()
    expect(getRelayWebSocketUrl()).toBe('ws://scorer-laptop:8080')
  })

  it('the page\'s own address typed in full connects too', async () => {
    render(<ServerConnectionScreen onConnected={onConnected} />)
    fireEvent.change(screen.getByPlaceholderText(/192\.168/), { target: { value: `${OWN}/` } })
    fireEvent.click(screen.getByText('Connect'))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith({ serverUrl: OWN }))
    expect(getBackendUrl()).toBe(OWN)
  })

  it('another plain host name is still refused, with no request', async () => {
    render(<ServerConnectionScreen onConnected={onConnected} />)
    fireEvent.change(screen.getByPlaceholderText(/192\.168/), { target: { value: 'http://other-laptop:5173' } })
    fireEvent.click(screen.getByText('Connect'))
    expect(await screen.findByText(/This address can't be used/)).toBeInTheDocument()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('a link naming the page\'s own server connects at once, asking nothing', async () => {
    window.history.replaceState({}, '', `/livescore/?server=${encodeURIComponent(OWN)}`)
    render(<ServerConnectionScreen onConnected={onConnected} />)
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith({ serverUrl: OWN }))
    expect(screen.queryByTestId('link-server-confirm')).toBeNull()
    expect(screen.queryByText(/This address can't be used/)).toBeNull()
    expect(getBackendUrl()).toBe(OWN)
  })

  it('a link naming the page\'s own server wins over a server typed earlier, for this tab', async () => {
    setBackendOverride('http://192.168.1.30:8080') // typed on this tablet before
    window.history.replaceState({}, '', `/livescore/?server=${encodeURIComponent(OWN)}`)
    render(<ServerConnectionScreen onConnected={onConnected} />)
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith({ serverUrl: OWN }))
    expect(screen.queryByText(/could not keep/)).toBeNull()
    expect(getBackendUrl()).toBe(OWN)
    expect(getRelayWebSocketUrl()).toBe('ws://scorer-laptop:8080')
    // the device's choice for later visits is left alone
    expect(localStorage.getItem('openvolley_backend_override')).toBe('http://192.168.1.30:8080')
  })
})
