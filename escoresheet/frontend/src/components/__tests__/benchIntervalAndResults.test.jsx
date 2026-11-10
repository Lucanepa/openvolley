import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'

// 3.0.16 test match, the bench tablet:
// - between sets 1 and 2 the scorer and the referee were on set 2, the
//   bench's own Line-up button said "Set 2", but its header showed "SET 1"
//   until the set 2 line-up created the set;
// - its match-end result table had no team names over A / B and no Start,
//   End or Duration, while the scorer showed them.

let bundle = null
vi.mock('../../utils/serverDataSync', () => ({ getMatchData: vi.fn(async () => bundle), addRelayMessageListener: () => () => {}, sendRelayMessage: () => false }))
vi.mock('../../hooks/useRealtimeConnection', () => ({ useRealtimeConnection: () => ({}) }))
vi.mock('../../db/db', () => ({ db: { matches: { get: vi.fn(async () => null), update: vi.fn(async () => 0) } } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k, d, o) => (typeof d === 'string' ? d : (o?.defaultValue || k)), i18n: { language: 'en' } }) }))

const { default: MatchEntry } = await import('../MatchEntry.jsx')

const players = (list) => list.map(number => ({ number, firstName: 'A', lastName: `P${number}` }))
const base = (match = {}) => ({
  success: true,
  match: {
    id: 'm1', status: 'live', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true, firstServe: 'home', bestOf: 5,
    homeShortName: 'ZÜRICH', awayShortName: 'LUZERN', ...match
  },
  homeTeam: { name: 'VBC Zürich', color: '#e2001a' },
  awayTeam: { name: 'Volley Luzern', color: '#3b82f6' },
  homePlayers: players([1, 10, 88, 14, 99, 12]),
  awayPlayers: players([2, 11, 55, 66, 98, 13])
})
const at = (h, m) => new Date(Date.UTC(2026, 10, 9, h, m)).toISOString()

describe('bench header: the set during the interval', () => {
  beforeEach(() => { cleanup(); bundle = null })

  it('shows the coming set the live state names, not set 1', async () => {
    bundle = {
      ...base(),
      sets: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }],
      events: [],
      liveState: { current_set: 2, set_interval_active: true, match_status: 'interval' }
    }
    const { container } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(container.querySelector('[data-bench-set]')).not.toBeNull())
    expect(container.querySelector('[data-bench-set]').textContent).toBe('2')
  })

  it('without a live state: the set after the last finished one; a set under way: that set', async () => {
    bundle = { ...base(), sets: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }], events: [] }
    const first = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(first.container.querySelector('[data-bench-set]')?.textContent).toBe('2'))
    cleanup()
    bundle = { ...base(), sets: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }, { index: 2, homePoints: 3, awayPoints: 1, finished: false }], events: [] }
    const second = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(second.container.querySelector('[data-bench-set]')?.textContent).toBe('2'))
  })

  it('a best-of-3 decider (index 5) is set 3', async () => {
    bundle = {
      ...base({ bestOf: 3 }),
      sets: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }, { index: 2, homePoints: 20, awayPoints: 25, finished: true }],
      events: [],
      liveState: { current_set: 5, set_interval_active: true }
    }
    const { container } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(container.querySelector('[data-bench-set]')?.textContent).toBe('3'))
  })
})

describe('bench match end: the result table', () => {
  beforeEach(() => { cleanup(); bundle = null })

  it('has the team names, Start, End and Duration as the scoresheet', async () => {
    bundle = {
      ...base({ status: 'ended' }),
      sets: [
        { index: 1, homePoints: 25, awayPoints: 2, finished: true, startTime: at(14, 38), endTime: at(14, 59) },
        { index: 2, homePoints: 25, awayPoints: 1, finished: true, startTime: at(15, 1), endTime: at(15, 6) },
        { index: 3, homePoints: 25, awayPoints: 0, finished: true, startTime: at(15, 6), endTime: at(15, 7) }
      ],
      events: []
    }
    const { container, getByText } = render(<MatchEntry matchId="m1" team="away" onBack={() => {}} embedded />)
    await waitFor(() => expect(getByText('The match has ended')).toBeTruthy())
    const text = container.textContent
    expect(text).toContain('ZÜRICH')
    expect(text).toContain('LUZERN')
    // 15:38 to 16:07 Zürich time (UTC+1 in November): 29 minutes
    expect(text).toContain('15 h 38 min')
    expect(text).toContain('16 h 07 min')
    expect(text).toContain('0 h 29 min')
  })
})
