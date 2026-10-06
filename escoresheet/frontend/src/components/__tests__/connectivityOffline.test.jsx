import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => String(typeof fallback === 'string' ? fallback : key) })
}))
vi.mock('../../db/db', () => ({ db: {} }))
vi.mock('../../hooks/useSyncQueue', () => ({ useSyncQueueStats: () => ({ pending: 0, error: 0, failed: 0 }) }))

import ConnectionStatus from '../ConnectionStatus'
import StartupConnectivityModal from '../StartupConnectivityModal'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('StartupConnectivityModal while offline', () => {
  it('a reload without network resumes silently: no blocking modal, no persistent offline mode', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const onDismiss = vi.fn()
    const onGoOffline = vi.fn()
    const { container } = render(
      <StartupConnectivityModal open connectionStatuses={{ db: 'connected', supabase: 'unknown', websocket: 'unknown' }} onDismiss={onDismiss} onGoOffline={onGoOffline} />
    )
    expect(container).toBeEmptyDOMElement()
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onGoOffline).not.toHaveBeenCalled()
  })

  it('going offline while it is shown closes it the same way', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const onDismiss = vi.fn()
    render(<StartupConnectivityModal open connectionStatuses={{ db: 'connected', supabase: 'connecting', websocket: 'unknown' }} onDismiss={onDismiss} onGoOffline={() => {}} />)
    expect(screen.getByText('Connecting...')).toBeInTheDocument()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    act(() => { window.dispatchEvent(new Event('offline')) })
    expect(screen.queryByText('Connecting...')).toBeNull()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('online, no cloud and no local server but a working database: the scorer chooses (Dismiss or Go offline), no auto-dismiss', () => {
    vi.useFakeTimers()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const onDismiss = vi.fn()
    const onGoOffline = vi.fn()
    render(<StartupConnectivityModal open connectionStatuses={{ db: 'connected', supabase: 'offline', websocket: 'disconnected' }} onDismiss={onDismiss} onGoOffline={onGoOffline} />)
    expect(screen.getByText(/Scoring still works offline/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Dismiss'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onGoOffline).not.toHaveBeenCalled()
    expect(screen.getByText('Go offline')).toBeInTheDocument() // still offered, not the only way out
    expect(screen.queryByText(/\(\d+s\)/)).toBeNull() // no countdown
    act(() => { vi.advanceTimersByTime(6000) })
    expect(onDismiss).toHaveBeenCalledTimes(1) // only the click: it never closes by itself
  })

  it('desktop app at a venue without internet: local server connected, cloud sync reads Offline (neutral) with a note', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<StartupConnectivityModal open connectionStatuses={{ db: 'connected', supabase: 'offline', websocket: 'connected' }} onDismiss={() => {}} onGoOffline={() => {}} />)
    expect(screen.getByText('Connected via local server')).toBeInTheDocument()
    expect(screen.getByText(/cloud sync starts as soon as this device is online/)).toBeInTheDocument()
    const offline = screen.getByText('Offline')
    expect(offline.className).toContain('text-stone-500')
    expect(offline.className).not.toContain('text-red')
    expect(screen.queryByText(/Scoring still works offline/)).toBeNull()
  })

  it('desktop app online: cloud sync Connected, no offline note', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<StartupConnectivityModal open connectionStatuses={{ db: 'connected', supabase: 'connected', websocket: 'connected' }} onDismiss={() => {}} onGoOffline={() => {}} />)
    expect(screen.getByText('All services connected!')).toBeInTheDocument()
    expect(screen.getByText('Cloud sync').parentElement).toHaveTextContent(/Connected/)
    expect(screen.queryByText(/cloud sync starts as soon/)).toBeNull()
  })

  it('synced: closes by itself after the countdown', () => {
    vi.useFakeTimers()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const onDismiss = vi.fn()
    render(<StartupConnectivityModal open connectionStatuses={{ db: 'connected', supabase: 'connected', websocket: 'disconnected' }} onDismiss={onDismiss} onGoOffline={() => {}} />)
    expect(screen.getByText('(5s)')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(6000) })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('synced: the auto-dismiss does not update the parent while the modal renders', () => {
    vi.useFakeTimers()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Parent() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <span>{open ? 'modal open' : 'modal closed'}</span>
          <StartupConnectivityModal open={open} connectionStatuses={{ db: 'connected', supabase: 'connected', websocket: 'disconnected' }} onDismiss={() => setOpen(false)} onGoOffline={() => {}} />
        </>
      )
    }
    render(<Parent />)
    act(() => { vi.advanceTimersByTime(6000) })
    expect(screen.getByText('modal closed')).toBeInTheDocument()
    const renderPhaseUpdates = consoleError.mock.calls.filter(args => String(args[0]).includes('Cannot update a component'))
    expect(renderPhaseUpdates).toHaveLength(0)
  })

  it('synced: reopened after an auto-dismiss, it counts down 5 s again instead of closing at once', () => {
    vi.useFakeTimers()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    let reopen
    function Parent() {
      const [open, setOpen] = useState(true)
      reopen = () => setOpen(true)
      return (
        <>
          <span>{open ? 'modal open' : 'modal closed'}</span>
          <StartupConnectivityModal open={open} connectionStatuses={{ db: 'connected', supabase: 'connected', websocket: 'disconnected' }} onDismiss={() => setOpen(false)} onGoOffline={() => {}} />
        </>
      )
    }
    render(<Parent />)
    act(() => { vi.advanceTimersByTime(6000) })
    expect(screen.getByText('modal closed')).toBeInTheDocument()

    act(() => { reopen() })
    expect(screen.getByText('modal open')).toBeInTheDocument()
    expect(screen.getByText('(5s)')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByText('modal open')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.getByText('modal closed')).toBeInTheDocument()
  })

  it('reopened with sync still connecting, it waits for sync and then counts down 5 s', () => {
    vi.useFakeTimers()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    let reopen, setStatuses
    const SYNCED = { db: 'connected', supabase: 'connected', websocket: 'disconnected' }
    function Parent() {
      const [open, setOpen] = useState(true)
      const [statuses, setS] = useState(SYNCED)
      reopen = () => setOpen(true)
      setStatuses = setS
      return (
        <>
          <span>{open ? 'modal open' : 'modal closed'}</span>
          <StartupConnectivityModal open={open} connectionStatuses={statuses} onDismiss={() => setOpen(false)} onGoOffline={() => {}} />
        </>
      )
    }
    render(<Parent />)
    act(() => { vi.advanceTimersByTime(6000) })
    expect(screen.getByText('modal closed')).toBeInTheDocument()

    act(() => { setStatuses({ ...SYNCED, supabase: 'connecting' }); reopen() })
    expect(screen.getByText('Connecting...')).toBeInTheDocument()
    act(() => { setStatuses(SYNCED) })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByText('modal open')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.getByText('modal closed')).toBeInTheDocument()
  })
})

describe('ConnectionStatus dropdown while offline', () => {
  const STATUSES = { api: 'disconnected', server: 'disconnected', websocket: 'connected', scoreboard: 'disconnected', match: 'live', db: 'connected', supabase: 'offline' }

  it('does not claim "WebSocket: Connected" when the browser is offline and no local server answers', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<ConnectionStatus connectionStatuses={STATUSES} queueStats={{ pending: 9, error: 0, failed: 0 }} />)
    fireEvent.click(screen.getByText(/^Offline/))
    expect(screen.getByText('WebSocket:').parentElement).toHaveTextContent(/^WebSocket:\s*Disconnected/)
  })

  it('keeps a local relay (offline desktop / LAN scoretable) shown as connected', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<ConnectionStatus connectionStatuses={{ ...STATUSES, server: 'connected' }} queueStats={{ pending: 0, error: 0, failed: 0 }} />)
    // The pill: the venue works, the cloud waits
    fireEvent.click(screen.getByText('Local only'))
    expect(screen.getByText('WebSocket:').parentElement).toHaveTextContent(/^WebSocket:\s*Connected$/)
  })
})
