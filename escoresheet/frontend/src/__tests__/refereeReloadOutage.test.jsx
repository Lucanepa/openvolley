import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

// A referee tablet that reloads while the server is down (2026-10-27
// re-verification of the bench's outage fix): its stored credentials were
// kept, but nothing checked them again, and it stayed on the PIN step once
// the server was back. A match only on the relay (a test match) is known to a
// relay that has just restarted only once its scorer publishes it again.

const SEED = 'match_1791223004296_b2mej1'
const PIN = '314159'

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
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } })
}))
vi.mock('../components/Referee', () => ({
  default: ({ matchId }) => <div data-testid="dashboard">{String(matchId)}</div>
}))
vi.mock('../components/UpdateBanner', () => ({ default: () => null }))
vi.mock('../components/DashboardHeader', () => ({ default: () => null }))
vi.mock('../components/ServerConnectionScreen', () => ({ default: () => <div>server screen</div> }))
vi.mock('../db/db', () => ({ db: { matches: { count: vi.fn().mockResolvedValue(0) } } }))
vi.mock('../utils/backendConfig', async (importOriginal) => ({ ...(await importOriginal()), isServedFromLocalServer: () => true }))

import RefereeApp from '../RefereeApp'

const offline = () => {
  sync.validatePinSupabase.mockResolvedValue({ success: false, error: 'Failed to fetch', unreachable: true })
  sync.validatePin.mockRejectedValue(new TypeError('Failed to fetch'))
}
// the server answers, the relay does not know the match (yet): 404 from both
const unknownMatch = () => {
  sync.validatePinSupabase.mockResolvedValue({ success: false, error: 'Invalid PIN code', status: 404 })
  sync.validatePin.mockRejectedValue(Object.assign(new Error('No match found with this PIN.'), { status: 404 }))
}
const published = () => sync.validatePin.mockResolvedValue({ success: true, match: { id: SEED, refereeConnectionEnabled: true, status: 'live' } })

describe('referee reloading during an outage', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    for (const fn of Object.values(sync)) fn.mockReset()
    sync.listAvailableMatchesSupabase.mockResolvedValue({ success: false, matches: [] })
    sync.listAvailableMatches.mockResolvedValue({ success: false, matches: [] })
    sync.getRelayServerStatus.mockResolvedValue({ running: false })
    localStorage.setItem('refereeMatchId', SEED)
    localStorage.setItem('refereePin', PIN)
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('keeps its credentials and joins once the server and the scorer are back', async () => {
    offline()
    render(<RefereeApp />)
    await screen.findByText('No connection to the server. The referee dashboard reconnects to its match as soon as it is back.')
    expect(screen.queryByTestId('dashboard')).toBeNull()

    // the server is back, the scorer not yet: the credentials stay
    unknownMatch()
    await screen.findByText('The server is back. The referee dashboard rejoins its match as soon as the scoresheet has reconnected.', {}, { timeout: 8000 })
    expect(localStorage.getItem('refereeMatchId')).toBe(SEED)
    expect(localStorage.getItem('refereePin')).toBe(PIN)

    // the scorer published the match again: the referee joins on its own
    published()
    expect((await screen.findByTestId('dashboard', {}, { timeout: 8000 })).textContent).toBe(SEED)
    expect(sync.validatePinSupabase).toHaveBeenCalledWith(PIN, 'referee', { matchExternalId: SEED })
  }, 25000)

  it('without an outage, credentials the server refuses are dropped at once, as before', async () => {
    unknownMatch()
    render(<RefereeApp />)
    await waitFor(() => expect(localStorage.getItem('refereeMatchId')).toBeNull())
    expect(localStorage.getItem('refereePin')).toBeNull()
    expect(sync.validatePin).toHaveBeenCalledTimes(1)
  })
})
