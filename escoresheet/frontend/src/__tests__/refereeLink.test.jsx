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
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } })
}))
vi.mock('../components/Referee', () => ({
  default: ({ matchId }) => <div data-testid="dashboard">{String(matchId)}</div>
}))
vi.mock('../components/UpdateBanner', () => ({ default: () => null }))
vi.mock('../components/DashboardHeader', () => ({ default: () => null }))
vi.mock('../components/ServerConnectionScreen', () => ({ default: ({ onConnected }) => <button onClick={onConnected}>server screen</button> }))
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
    // the typed PIN is checked for the match of the link (its own PIN budget)
    expect(sync.validatePinSupabase).toHaveBeenCalledWith('786270', 'referee', { matchExternalId: SEED })
    expect(localStorage.getItem('refereeMatchId')).toBe(SEED)
  })

  // 2026-10-27 review: after a wrong court's QR code, the referee picks the
  // right game in the list. Its right PIN went out checked against the
  // link's match (404, "Invalid PIN") until a reload without the link.
  it('a game picked in the list after the link is the one the PIN is checked against', async () => {
    const OTHER = 'match_1791223004297_c3nfk2'
    const listed = [
      { id: SEED, gameNumber: 991202, homeTeam: 'Home A', awayTeam: 'Away A', status: 'live', refereeConnectionEnabled: true },
      { id: OTHER, gameNumber: 991203, homeTeam: 'Home B', awayTeam: 'Away B', status: 'live', refereeConnectionEnabled: true }
    ]
    sync.listAvailableMatchesSupabase.mockResolvedValue({ success: true, matches: listed })
    // The backend checks a PIN that names its match against that match only
    sync.validatePinSupabase.mockImplementation(async (pin, type, opts) =>
      pin === '445566' && (!opts?.matchExternalId || opts.matchExternalId === OTHER)
        ? { success: true, match: { id: OTHER, refereeConnectionEnabled: true, status: 'live' } }
        : { success: false, status: 404, error: 'Invalid PIN code' })
    sync.validatePin.mockRejectedValue(new Error('No match found with this PIN.'))

    render(<RefereeApp />)
    await waitFor(() => expect(sync.getMatchData).toHaveBeenCalledWith(SEED))
    fireEvent.click(await screen.findByRole('button', { name: 'refereeDashboard.selectGame' }))
    fireEvent.click(await screen.findByRole('button', { name: /Home B/ }))

    fireEvent.change(screen.getByLabelText('refereeDashboard.connectionPin'), { target: { value: '445566' } })
    fireEvent.click(screen.getByRole('button', { name: 'refereeDashboard.enter' }))

    const dashboard = await screen.findByTestId('dashboard')
    expect(dashboard.textContent).toBe(OTHER)
    expect(sync.validatePinSupabase).toHaveBeenCalledWith('445566', 'referee', { matchExternalId: OTHER })
    expect(localStorage.getItem('refereeMatchId')).toBe(OTHER)
  })

  it('picking the linked game itself in the list keeps the link\'s match', async () => {
    sync.listAvailableMatchesSupabase.mockResolvedValue({ success: true, matches: [
      { id: SEED, gameNumber: 991202, homeTeam: 'Home A', awayTeam: 'Away A', status: 'live', refereeConnectionEnabled: true }
    ] })
    render(<RefereeApp />)
    await waitFor(() => expect(sync.getMatchData).toHaveBeenCalledWith(SEED))
    fireEvent.click(await screen.findByRole('button', { name: 'refereeDashboard.selectGame' }))
    fireEvent.click(await screen.findByRole('button', { name: /Home A/ }))

    fireEvent.change(screen.getByLabelText('refereeDashboard.connectionPin'), { target: { value: '786270' } })
    fireEvent.click(screen.getByRole('button', { name: 'refereeDashboard.enter' }))

    expect((await screen.findByTestId('dashboard')).textContent).toBe(SEED)
    expect(sync.validatePinSupabase).toHaveBeenCalledWith('786270', 'referee', { matchExternalId: SEED })
  })

  it('a game number two listed matches share names no match in the check', async () => {
    Object.defineProperty(window, 'location', { value: { ...realLocation, search: '' }, writable: true, configurable: true })
    const OTHER = 'match_1791223004297_c3nfk2'
    sync.listAvailableMatchesSupabase.mockResolvedValue({ success: true, matches: [
      { id: SEED, gameNumber: 1, homeTeam: 'Home A', awayTeam: 'Away A', status: 'live', refereeConnectionEnabled: true },
      { id: OTHER, gameNumber: 1, homeTeam: 'Home B', awayTeam: 'Away B', status: 'live', refereeConnectionEnabled: true }
    ] })
    sync.validatePinSupabase.mockResolvedValue({ success: true, match: { id: OTHER, refereeConnectionEnabled: true, status: 'live' } })
    render(<RefereeApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'server screen' }))
    fireEvent.click(await screen.findByRole('button', { name: 'refereeDashboard.selectGame' }))
    fireEvent.click(await screen.findByRole('button', { name: /Home B/ }))
    fireEvent.change(screen.getByLabelText('refereeDashboard.connectionPin'), { target: { value: '445566' } })
    fireEvent.click(screen.getByRole('button', { name: 'refereeDashboard.enter' }))

    expect((await screen.findByTestId('dashboard')).textContent).toBe(OTHER)
    expect(sync.validatePinSupabase).toHaveBeenCalledWith('445566', 'referee')
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
