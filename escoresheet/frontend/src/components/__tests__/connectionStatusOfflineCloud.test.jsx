import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, opts) => String(typeof fallback === 'string' ? fallback : key)
      .replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''))
  })
}))
vi.mock('../../db/db', () => ({ db: {} }))
const live = vi.hoisted(() => ({ value: { pending: 0, error: 0, failed: 0 } }))
vi.mock('../../hooks/useSyncQueue', () => ({ useSyncQueueStats: () => live.value }))
// Where the backend is: the cloud (backend.openvolley.app) or the venue LAN
const net = vi.hoisted(() => ({ lan: false }))
vi.mock('../../utils/localNetwork', () => ({ backendOnLocalNetwork: () => net.lan }))

import ConnectionStatus from '../ConnectionStatus'

// What the last 30 s poll said, just before the network dropped
const POLLED_ONLINE = { api: 'connected', server: 'connected', websocket: 'connected', scoreboard: 'connected', match: 'live', db: 'connected', supabase: 'connected' }

function goOffline() {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  act(() => { window.dispatchEvent(new Event('offline')) })
}

afterEach(() => {
  vi.restoreAllMocks()
  net.lan = false
  live.value = { pending: 0, error: 0, failed: 0 }
})

describe('ConnectionStatus when the browser goes offline (cloud backend)', () => {
  it('says Offline at once, with the waiting count, although the last poll said connected', () => {
    live.value = { pending: 6, error: 0, failed: 0 }
    render(<ConnectionStatus connectionStatuses={POLLED_ONLINE} />)
    expect(screen.getByText('Syncing...')).toBeInTheDocument()

    goOffline()
    expect(screen.queryByText('Syncing...')).toBeNull()
    expect(screen.queryByText('Connected')).toBeNull()
    expect(screen.getByText('Offline (6 waiting)')).toBeInTheDocument()
  })

  it('shows the remote paths as offline in the menu', () => {
    render(<ConnectionStatus connectionStatuses={POLLED_ONLINE} />)
    goOffline()
    fireEvent.click(screen.getByText('Offline'))
    expect(screen.getByText('Server:').parentElement).toHaveTextContent(/^Server:\s*Offline/)
    expect(screen.getByText('Cloud sync:').parentElement).toHaveTextContent(/^Cloud sync:\s*Offline/)
    expect(screen.getByText('WebSocket:').parentElement).toHaveTextContent(/^WebSocket:\s*Disconnected/)
  })

  it('comes back as soon as the browser is online again', () => {
    render(<ConnectionStatus connectionStatuses={POLLED_ONLINE} />)
    goOffline()
    expect(screen.getByText('Offline')).toBeInTheDocument()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(screen.getByText('Connected')).toBeInTheDocument()
  })
})

describe('ConnectionStatus when the browser goes offline (LAN / local backend)', () => {
  it('keeps the venue server path: the match runs, only the cloud copy waits', () => {
    net.lan = true
    live.value = { pending: 3, error: 0, failed: 0 }
    render(<ConnectionStatus connectionStatuses={{ ...POLLED_ONLINE, supabase: 'offline' }} />)
    goOffline()
    expect(screen.getByText('Syncing...')).toBeInTheDocument()
  })

  it('is offline once the LAN server is not connected either', () => {
    net.lan = true
    render(<ConnectionStatus connectionStatuses={{ ...POLLED_ONLINE, server: 'disconnected' }} />)
    goOffline()
    expect(screen.getByText('Offline')).toBeInTheDocument()
  })
})
