import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => String(typeof fallback === 'string' ? fallback : key) })
}))
vi.mock('../../utils/backendConfig', () => ({ getLocalServerStatusUrl: () => 'http://localhost:5173/api/server/status' }))

import LanTabletsModal, { lanTabletUrls } from '../LanTabletsModal'

// What the desktop app's Rust relay answers on /api/server/status
const RUST_STATUS = {
  running: true,
  localIP: '192.168.1.42',
  port: 5173,
  wsPort: 8080,
  urls: {
    main: 'http://192.168.1.42:5173/',
    mainIP: 'http://192.168.1.42:5173/',
    referee: 'http://192.168.1.42:5173/referee',
    refereeIP: 'http://192.168.1.42:5173/referee',
    bench: 'http://192.168.1.42:5173/bench',
    benchIP: 'http://192.168.1.42:5173/bench',
    livescore: 'http://192.168.1.42:5173/livescore',
    livescoreIP: 'http://192.168.1.42:5173/livescore'
  }
}

describe('lanTabletUrls', () => {
  it('reads the LAN addresses the relay reports', () => {
    expect(lanTabletUrls(RUST_STATUS).map(r => r.url)).toEqual([
      'http://192.168.1.42:5173/',
      'http://192.168.1.42:5173/referee',
      'http://192.168.1.42:5173/bench',
      'http://192.168.1.42:5173/livescore'
    ])
  })

  it('builds them from the IP and port when a relay sends no urls', () => {
    expect(lanTabletUrls({ localIP: '10.0.0.5', port: 3000 }).map(r => r.url)).toEqual([
      'http://10.0.0.5:3000/', 'http://10.0.0.5:3000/referee', 'http://10.0.0.5:3000/bench', 'http://10.0.0.5:3000/livescore'
    ])
    expect(lanTabletUrls(null)).toEqual([])
    expect(lanTabletUrls({ running: true })).toEqual([])
  })
})

describe('LanTabletsModal', () => {
  it('lists the tablet addresses from the local server', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => RUST_STATUS }))
    render(<LanTabletsModal open onClose={() => {}} fetchImpl={fetchImpl} />)
    expect(screen.getByText('Connect tablets')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('lan-tablet-urls')).toBeInTheDocument())
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:5173/api/server/status')
    expect(screen.getByText('http://192.168.1.42:5173/referee')).toBeInTheDocument()
    expect(screen.getByText('http://192.168.1.42:5173/livescore')).toBeInTheDocument()
  })

  it('says so when the local server does not answer', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    render(<LanTabletsModal open onClose={() => {}} fetchImpl={fetchImpl} />)
    await waitFor(() => expect(screen.getByText(/The local server does not answer/)).toBeInTheDocument())
  })
})
