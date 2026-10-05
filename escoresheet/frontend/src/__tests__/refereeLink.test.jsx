import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// The referee's QR code / match link (?server=&match=<seed key>) preselects
// the match and still asks for the referee PIN, like the bench link. It used
// to connect without a PIN and follow the relay copy's match.id: the scorer's
// Dexie id 1, a room every scorer's first match shares.

const SEED = 'match_1791223004296_b2mej1'

const sync = vi.hoisted(() => ({
  getMatchData: vi.fn(),
  validatePin: vi.fn(),
  validatePinSupabase: vi.fn(),
  listAvailableMatches: vi.fn(),
  listAvailableMatchesSupabase: vi.fn(),
  getRelayServerStatus: vi.fn(),
  setRelayDevice: vi.fn()
}))

vi.mock('../utils/serverDataSync', () => sync)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}))
vi.mock('../components/Referee', () => ({
  default: ({ matchId }) => <div data-testid="dashboard">{String(matchId)}</div>
}))
vi.mock('../components/UpdateBanner', () => ({ default: () => null }))
vi.mock('../components/DashboardHeader', () => ({ default: () => null }))
vi.mock('../components/ServerConnectionScreen', () => ({ default: () => <div>server screen</div> }))
vi.mock('../db/db', () => ({ db: { matches: { count: vi.fn().mockResolvedValue(0) } } }))

import RefereeApp from '../RefereeApp'

describe('referee match link', () => {
  let realLocation

  beforeEach(() => {
    localStorage.clear()
    for (const fn of Object.values(sync)) fn.mockReset()
    // The relay copy carries the scorer's Dexie id
    sync.getMatchData.mockResolvedValue({ success: true, match: { id: 1, gameNumber: 991202, status: 'live' } })
    sync.listAvailableMatchesSupabase.mockResolvedValue({ success: true, matches: [] })
    sync.listAvailableMatches.mockResolvedValue({ success: true, matches: [] })
    sync.getRelayServerStatus.mockResolvedValue({ running: true })
    sync.validatePinSupabase.mockResolvedValue({ success: true, match: { id: SEED, refereeConnectionEnabled: true, status: 'live' } })
    sync.validatePin.mockResolvedValue({ success: false })
    realLocation = window.location
    Object.defineProperty(window, 'location', {
      value: { ...realLocation, search: `?server=${encodeURIComponent('https://backend.openvolley.app')}&match=${SEED}` },
      writable: true,
      configurable: true
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', { value: realLocation, writable: true, configurable: true })
    localStorage.clear()
  })

  it('asks for the PIN, then follows the match by the key the PIN check returns', async () => {
    render(<RefereeApp />)
    const pin = await screen.findByLabelText('refereeDashboard.connectionPin')
    expect(screen.queryByTestId('dashboard')).toBeNull()
    await waitFor(() => expect(sync.getMatchData).toHaveBeenCalledWith(SEED))

    fireEvent.change(pin, { target: { value: '786270' } })
    fireEvent.click(screen.getByRole('button', { name: 'refereeDashboard.enter' }))

    const dashboard = await screen.findByTestId('dashboard')
    expect(dashboard.textContent).toBe(SEED)
    expect(sync.validatePinSupabase).toHaveBeenCalledWith('786270', 'referee')
    expect(localStorage.getItem('refereeMatchId')).toBe(SEED)
  })

  it('a wrong PIN does not connect', async () => {
    sync.validatePinSupabase.mockResolvedValue({ success: false })
    render(<RefereeApp />)
    const pin = await screen.findByLabelText('refereeDashboard.connectionPin')
    fireEvent.change(pin, { target: { value: '123457' } })
    fireEvent.click(screen.getByRole('button', { name: 'refereeDashboard.enter' }))
    await screen.findByText('refereeDashboard.errors.invalidPin')
    expect(screen.queryByTestId('dashboard')).toBeNull()
  })
})
