import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

// 2026-11 audit (fe-secondary-apps-1): with no game picked (the list did not
// load, no link) a typed referee PIN was checked against every match, and the
// page opened whichever match answered, possibly another hall's. The referee
// now sees the game the PIN found and opens it only once they say it is theirs.

const SEED = 'match_1791223004296_f0und1'

const sync = vi.hoisted(() => ({
  getMatchData: vi.fn(),
  validatePin: vi.fn(),
  validatePinSupabase: vi.fn(),
  listAvailableMatches: vi.fn(),
  listAvailableMatchesSupabase: vi.fn(),
  getRelayServerStatus: vi.fn(),
  setRelayDevice: vi.fn()
}))

vi.mock('../utils/serverDataSync', async (importOriginal) => ({ ...(await importOriginal()), ...sync }))
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

describe('referee PIN with no game picked', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    for (const fn of Object.values(sync)) fn.mockReset()
    // neither list answers: the PIN form shows without a game
    sync.listAvailableMatchesSupabase.mockResolvedValue({ success: false, matches: [] })
    sync.listAvailableMatches.mockResolvedValue({ success: false, matches: [] })
    sync.getRelayServerStatus.mockResolvedValue({ running: true })
    sync.validatePinSupabase.mockResolvedValue({ success: false, error: 'Failed to fetch', unreachable: true })
    sync.validatePin.mockResolvedValue({ success: true, match: { id: SEED, gameNumber: 801, homeTeam: 'Home VC', awayTeam: 'Away VC', refereeConnectionEnabled: true, status: 'live' } })
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  const typePin = async () => {
    const pin = await screen.findByLabelText('refereeDashboard.connectionPin')
    fireEvent.change(pin, { target: { value: '786270' } })
    fireEvent.click(screen.getByRole('button', { name: 'refereeDashboard.enter' }))
  }

  it('shows the game the PIN found and opens it once the referee confirms', async () => {
    render(<RefereeApp />)
    await typePin()
    const found = await screen.findByTestId('referee-found-game')
    expect(found.textContent).toContain('Home VC')
    expect(found.textContent).toContain('Away VC')
    expect(screen.queryByTestId('dashboard')).toBeNull()
    expect(localStorage.getItem('refereeMatchId')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open this game' }))
    expect((await screen.findByTestId('dashboard')).textContent).toBe(SEED)
    expect(localStorage.getItem('refereeMatchId')).toBe(SEED)
    expect(localStorage.getItem('refereePin')).toBe('786270')
  })

  it('"Not my game" opens nothing and clears the PIN', async () => {
    render(<RefereeApp />)
    await typePin()
    await screen.findByTestId('referee-found-game')
    fireEvent.click(screen.getByRole('button', { name: 'Not my game' }))
    expect(screen.queryByTestId('referee-found-game')).toBeNull()
    expect(screen.queryByTestId('dashboard')).toBeNull()
    expect(screen.getByLabelText('refereeDashboard.connectionPin').value).toBe('')
    expect(localStorage.getItem('refereeMatchId')).toBeNull()
  })
})
