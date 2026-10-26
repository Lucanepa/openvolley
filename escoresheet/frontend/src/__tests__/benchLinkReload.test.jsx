import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

// A bench tablet joins through the match's link (QR code: /bench/?match=…&team=…)
// and enters its PIN. The link stays in the address, and every reload (tab
// discarded, pull to refresh, app update) comes back with it: the bench must
// restore its stored session there, as the referee does, not ask for the PIN
// again.

const SEED = 'match_1791215210058_yxkc82'
const PIN = '372449'

const sync = vi.hoisted(() => ({
  getMatchData: vi.fn(),
  validatePin: vi.fn(),
  validatePinSupabase: vi.fn(),
  listAvailableMatches: vi.fn(),
  listAvailableMatchesForBenchSupabase: vi.fn(),
  getRelayServerStatus: vi.fn(),
  getWebSocketStatus: vi.fn(),
  setRelayDevice: vi.fn()
}))

vi.mock('../utils/serverDataSync', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, ...sync }
})
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } })
}))
vi.mock('../components/MatchEntry', () => ({ default: () => <div>bench match view</div> }))
vi.mock('../components/UpdateBanner', () => ({ default: () => null }))
vi.mock('../components/DashboardHeader', () => ({ default: () => null }))
vi.mock('../components/ServerConnectionScreen', () => ({ default: () => <div>server screen</div> }))
vi.mock('../utils/backendConfig', async (importOriginal) => ({ ...(await importOriginal()), isServedFromLocalServer: () => true }))

import BenchApp from '../BenchApp'

const storeSession = (over = {}) => localStorage.setItem('bench_session', JSON.stringify({
  matchId: SEED, team: 'home', pin: PIN, gameNumber: 12, homeTeamName: 'Home VC', awayTeamName: 'Away VC', ...over
}))

describe('bench opened through its match link', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    for (const fn of Object.values(sync)) fn.mockReset()
    sync.listAvailableMatchesForBenchSupabase.mockResolvedValue({ success: true, matches: [] })
    sync.listAvailableMatches.mockResolvedValue({ success: true, matches: [] })
    sync.getRelayServerStatus.mockResolvedValue({ running: true })
    sync.getWebSocketStatus.mockReturnValue('disconnected')
    sync.getMatchData.mockResolvedValue({ success: false })
    sync.validatePinSupabase.mockResolvedValue({ success: true, match: { id: SEED, gameNumber: 12, homeTeamConnectionEnabled: true, status: 'live' } })
    window.history.replaceState({}, '', `/bench/?match=${SEED}&team=home`)
  })
  afterEach(() => {
    cleanup()
    window.history.replaceState({}, '', '/')
  })

  it('a reload restores the session it joined with: no PIN step', async () => {
    storeSession()
    render(<BenchApp />)
    await screen.findByText('bench match view')
    expect(sync.validatePinSupabase).toHaveBeenCalledWith(PIN, 'bench_home', { matchExternalId: SEED })
    // the link's PIN step (it loads the linked match's details) never ran
    expect(sync.getMatchData).not.toHaveBeenCalled()
  })

  it('a session of another match or team leaves the link\'s PIN step', async () => {
    storeSession({ matchId: 'match_other' })
    render(<BenchApp />)
    await waitFor(() => expect(sync.getMatchData).toHaveBeenCalledWith(SEED))
    expect(sync.validatePinSupabase).not.toHaveBeenCalled()
    cleanup()
    sync.getMatchData.mockClear()
    storeSession({ team: 'away' })
    render(<BenchApp />)
    await waitFor(() => expect(sync.getMatchData).toHaveBeenCalledWith(SEED))
    expect(sync.validatePinSupabase).not.toHaveBeenCalled()
  })

  it('a stored PIN that no longer opens the match falls back to the link\'s PIN step', async () => {
    storeSession()
    sync.validatePinSupabase.mockResolvedValue({ success: false, error: 'Invalid PIN code' })
    sync.validatePin.mockRejectedValue(Object.assign(new Error('No match found with this PIN.'), { status: 404 }))
    render(<BenchApp />)
    await waitFor(() => expect(sync.getMatchData).toHaveBeenCalledWith(SEED))
    expect(localStorage.getItem('bench_session')).toBeNull()
    expect(screen.queryByText('bench match view')).toBeNull()
  })
})
