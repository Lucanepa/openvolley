import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { refereeJoinableMatches, benchJoinableMatches } from '../utils/relayMatchList'

// A relay's GET /api/match/list lists every match a scorer publishes there
// (the LedBox bridge picks its match from it, no PIN). The referee and bench
// pickers offer only the matches they can join: a referee who picked a match
// with the referee connection off was thrown out with "connection disabled".

const row = (over) => ({
  id: over.id,
  gameNumber: over.gameNumber,
  homeTeam: `${over.id} home`,
  awayTeam: `${over.id} away`,
  scheduledAt: null,
  dateTime: 'TBD',
  status: 'live',
  test: false,
  refereeConnectionEnabled: false,
  homeTeamConnectionEnabled: false,
  awayTeamConnectionEnabled: false,
  ...over
})

const RELAY_LIST = [
  row({ id: 'ref-on', gameNumber: 101, refereeConnectionEnabled: true }),
  row({ id: 'all-off', gameNumber: 102 }),
  row({ id: 'bench-away', gameNumber: 103, awayTeamConnectionEnabled: true }),
  row({ id: 'rehearsal-off', gameNumber: 104, test: true }),
  row({ id: 'rehearsal-ref', gameNumber: 105, test: true, refereeConnectionEnabled: true })
]

const sync = vi.hoisted(() => ({
  getMatchData: vi.fn(),
  validatePin: vi.fn(),
  validatePinSupabase: vi.fn(),
  listAvailableMatches: vi.fn(),
  listAvailableMatchesSupabase: vi.fn(),
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
vi.mock('../components/Referee', () => ({ default: () => null }))
vi.mock('../components/MatchEntry', () => ({ default: () => null }))
vi.mock('../components/UpdateBanner', () => ({ default: () => null }))
vi.mock('../components/DashboardHeader', () => ({ default: () => null }))
vi.mock('../components/ServerConnectionScreen', () => ({ default: () => <div>server screen</div> }))
vi.mock('../db/db', () => ({ db: { matches: { count: vi.fn().mockResolvedValue(0) } } }))
vi.mock('../utils/backendConfig', async (importOriginal) => ({ ...(await importOriginal()), isServedFromLocalServer: () => true }))

import RefereeApp from '../RefereeApp'
import BenchApp from '../BenchApp'

describe('relay match list: what people can join', () => {
  it('the referee gets the matches with the referee connection on (a rehearsal the scorer opened for one too)', () => {
    expect(refereeJoinableMatches(RELAY_LIST).map((m) => m.id)).toEqual(['ref-on', 'rehearsal-ref'])
  })

  it('the bench gets the matches with a bench connection on', () => {
    expect(benchJoinableMatches(RELAY_LIST).map((m) => m.id)).toEqual(['bench-away'])
  })

  it('neither offers a match the relay still holds from long ago (stale: scheduled more than 12 h ago, not started)', () => {
    const now = Date.parse('2026-10-07T12:00:00Z')
    const rows = [
      row({ id: 'feb', gameNumber: 201, status: 'scheduled', scheduledAt: '2026-02-20T16:00:00Z', refereeConnectionEnabled: true, homeTeamConnectionEnabled: true }),
      row({ id: 'tonight', gameNumber: 202, status: 'scheduled', scheduledAt: '2026-10-07T18:00:00Z', refereeConnectionEnabled: true, homeTeamConnectionEnabled: true }),
      row({ id: 'playing', gameNumber: 203, status: 'live', scheduledAt: '2026-10-06T18:00:00Z', refereeConnectionEnabled: true, homeTeamConnectionEnabled: true }),
      // an old scorer app still publishing the live match it never finished
      row({ id: 'june-live', gameNumber: 204, status: 'live', scheduledAt: '2026-06-15T14:00:00Z', refereeConnectionEnabled: true, homeTeamConnectionEnabled: true })
    ]
    expect(refereeJoinableMatches(rows, now).map((m) => m.id)).toEqual(['tonight', 'playing'])
    expect(benchJoinableMatches(rows, now).map((m) => m.id)).toEqual(['tonight', 'playing'])
  })

  it('takes anything without throwing', () => {
    for (const bad of [undefined, null, 'x', [null, 1, 'y']]) {
      expect(refereeJoinableMatches(bad)).toEqual([])
      expect(benchJoinableMatches(bad)).toEqual([])
    }
  })
})

describe('the pickers offer only joinable relay matches', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    for (const fn of Object.values(sync)) fn.mockReset()
    // An offline venue: no cloud matches, the relay lists everything
    sync.listAvailableMatchesSupabase.mockResolvedValue({ success: true, matches: [] })
    sync.listAvailableMatchesForBenchSupabase.mockResolvedValue({ success: true, matches: [] })
    sync.listAvailableMatches.mockResolvedValue({ success: true, matches: RELAY_LIST })
    sync.getRelayServerStatus.mockResolvedValue({ running: true })
    sync.getWebSocketStatus.mockReturnValue('disconnected')
  })

  it('referee: no match with the referee connection off', async () => {
    render(<RefereeApp />)
    await waitFor(() => expect(sync.listAvailableMatches).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: 'refereeDashboard.selectGame' }))
    await screen.findByText('ref-on home')
    expect(screen.getByText('rehearsal-ref home')).toBeTruthy()
    for (const id of ['all-off', 'bench-away', 'rehearsal-off']) expect(screen.queryByText(`${id} home`)).toBeNull()
  })

  it('bench: no match without a bench connection, and the relay\'s team names', async () => {
    render(<BenchApp />)
    await screen.findByText('bench-away home')
    expect(screen.getByText('bench-away away')).toBeTruthy()
    for (const id of ['ref-on', 'all-off', 'rehearsal-off', 'rehearsal-ref']) expect(screen.queryByText(`${id} home`)).toBeNull()
  })
})
