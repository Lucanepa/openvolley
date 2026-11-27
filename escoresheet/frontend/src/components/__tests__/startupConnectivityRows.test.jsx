import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => String(typeof fallback === 'string' ? fallback : key) })
}))

import StartupConnectivityModal from '../StartupConnectivityModal'

// The start-up connection check lists every service from its first frame
// (owner 27.11.2026: a dialog with 2 rows, then a second later the one with
// all the rows). App opens it on its first render, with every status
// 'unknown' (App.jsx connectionStatuses), and the checks answer one by one.
const ALL_UNKNOWN = { api: 'unknown', server: 'unknown', websocket: 'unknown', scoreboard: 'unknown', match: 'unknown', db: 'unknown', supabase: 'unknown' }
const ROWS = ['db', 'supabase', 'api', 'server', 'websocket', 'scoreboard']

const dialog = () => screen.getByRole('dialog')
const rows = () => [...dialog().querySelectorAll('[data-service]')]
const rowKeys = () => rows().map((r) => r.dataset.service)
const row = (key) => dialog().querySelector(`[data-service="${key}"]`)

const heading = () => screen.getByRole('heading').textContent

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('StartupConnectivityModal rows', () => {
  it('the first render lists every service, each pending', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<StartupConnectivityModal open connectionStatuses={ALL_UNKNOWN} onDismiss={() => {}} onGoOffline={() => {}} />)
    expect(rowKeys()).toEqual(ROWS)
    for (const r of rows()) {
      expect(r.dataset.status).toBe('unknown')
      expect(r).toHaveTextContent('Connecting')
    }
    for (const label of ['Database', 'Cloud sync', 'API', 'Server', 'WebSocket', 'Scoreboard']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('the answers fill the same rows of the same dialog: none added, none removed', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const props = { open: true, onDismiss: () => {}, onGoOffline: () => {} }
    const { rerender } = render(<StartupConnectivityModal {...props} connectionStatuses={ALL_UNKNOWN} />)
    const firstDialog = dialog()
    const firstRows = rows()
    // the order App's checks answer in: database, cloud, API + server + scoreboard, relay
    const steps = [
      { db: 'connected' },
      { supabase: 'connecting' },
      { supabase: 'connected' },
      { api: 'connected', server: 'connected', scoreboard: 'connected' },
      { websocket: 'connected' }
    ]
    let statuses = ALL_UNKNOWN
    for (const step of steps) {
      statuses = { ...statuses, ...step }
      rerender(<StartupConnectivityModal {...props} connectionStatuses={statuses} />)
      expect(dialog()).toBe(firstDialog)
      expect(rowKeys()).toEqual(ROWS)
      rows().forEach((r, i) => expect(r).toBe(firstRows[i]))
      // the heading follows the rows: no 'connected' over rows still connecting
      const pending = rows().some((r) => ['unknown', 'connecting'].includes(r.dataset.status))
      if (pending) expect(heading()).toBe('Connecting...')
    }
    expect(screen.getByText('All services connected!')).toBeInTheDocument()
    for (const r of rows()) expect(r.dataset.status).toBe('connected')
  })

  it('database and cloud answered, other rows still connecting: heading Connecting..., Dismiss offered, no countdown; it starts after the last answer', () => {
    vi.useFakeTimers()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const onDismiss = vi.fn()
    const props = { open: true, onDismiss, onGoOffline: () => {} }
    const synced = { ...ALL_UNKNOWN, db: 'connected', supabase: 'connected' }
    const { rerender } = render(<StartupConnectivityModal {...props} connectionStatuses={synced} />)
    expect(heading()).toBe('Connecting...')
    expect(screen.queryByText('All services connected!')).toBeNull()
    expect(screen.getByRole('button', { name: /^Dismiss/ })).toBeInTheDocument()
    expect(screen.queryByText(/\(\d+s\)/)).toBeNull()
    act(() => { vi.advanceTimersByTime(6000) })
    expect(onDismiss).not.toHaveBeenCalled()

    rerender(<StartupConnectivityModal {...props} connectionStatuses={{ ...synced, api: 'connected', server: 'connected', scoreboard: 'connected' }} />)
    expect(heading()).toBe('Connecting...') // the relay row has not answered yet
    rerender(<StartupConnectivityModal {...props} connectionStatuses={{ ...synced, api: 'connected', server: 'connected', scoreboard: 'connected', websocket: 'connected' }} />)
    expect(heading()).toBe('All services connected!')
    expect(screen.getByText('(5s)')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(6000) })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('a fallback service not reached: the heading never says all services are connected', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<StartupConnectivityModal open connectionStatuses={{ ...ALL_UNKNOWN, db: 'connected', supabase: 'connected', api: 'connected', server: 'connected', scoreboard: 'connected', websocket: 'disconnected' }} onDismiss={() => {}} onGoOffline={() => {}} />)
    expect(heading()).toBe('Connection status')
    expect(screen.queryByText('All services connected!')).toBeNull()
    expect(screen.getByText('(5s)')).toBeInTheDocument() // synced: it still closes by itself
  })

  it('no sync path, every row answered: neutral heading and the note, never Connecting...', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<StartupConnectivityModal open connectionStatuses={{ ...ALL_UNKNOWN, db: 'connected', supabase: 'offline', api: 'disconnected', server: 'disconnected', scoreboard: 'disconnected', websocket: 'disconnected' }} onDismiss={() => {}} onGoOffline={() => {}} />)
    expect(heading()).toBe('Connection status')
    expect(screen.getByText(/No server or cloud connection available/)).toBeInTheDocument()
  })

  it('a fallback service not reached keeps its row, quiet: no red cross, no red text', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(
      <StartupConnectivityModal
        open
        connectionStatuses={{ ...ALL_UNKNOWN, db: 'connected', supabase: 'offline', api: 'disconnected', server: 'disconnected', scoreboard: 'disconnected', websocket: 'connected' }}
        onDismiss={() => {}}
        onGoOffline={() => {}}
      />
    )
    expect(rowKeys()).toEqual(ROWS)
    expect(screen.getByText('Connected via local server')).toBeInTheDocument()
    for (const key of ['api', 'server', 'scoreboard']) {
      expect(row(key)).toHaveTextContent('Disconnected')
      expect(row(key).innerHTML).not.toMatch(/text-red/)
    }
  })

  it('the database not reached is still an error (red)', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<StartupConnectivityModal open connectionStatuses={{ ...ALL_UNKNOWN, db: 'disconnected', supabase: 'connected', websocket: 'connected' }} onDismiss={() => {}} onGoOffline={() => {}} />)
    expect(row('db')).toHaveTextContent('Disconnected')
    expect(row('db').innerHTML).toMatch(/text-red-700/)
  })
})
