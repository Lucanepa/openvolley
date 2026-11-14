import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'

// The bench bundle the cloud relay sends a bench PIN (backend/lib/publicColumns.js
// relayBundleView): its own roster by name, the other team's shirt numbers
// only, the other team's officials by role only. The bench page draws its
// chips from its own team (numbers, role codes) and needs nothing else.

let bundle = null
vi.mock('../../utils/serverDataSync', () => ({ getMatchData: vi.fn(async () => bundle), addRelayMessageListener: () => () => {}, sendRelayMessage: () => false }))
vi.mock('../../hooks/useRealtimeConnection', () => ({ useRealtimeConnection: () => ({}) }))
vi.mock('../../db/db', () => ({ db: { matches: { get: vi.fn(async () => null), update: vi.fn(async () => 0) } } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k, d, o) => (typeof d === 'string' ? d : (o?.defaultValue || k)), i18n: { language: 'en' } }) }))

const { default: MatchEntry } = await import('../MatchEntry.jsx')

const lineup = (first) => ({ I: first, II: first + 1, III: first + 2, IV: first + 3, V: first + 4, VI: first + 5 })

describe('the bench page on its bench bundle', () => {
  beforeEach(() => { cleanup(); bundle = null })

  it('shows its own bench and officials with the other team as numbers only', async () => {
    bundle = {
      success: true,
      access: 'full',
      match: {
        id: 'm1', status: 'live', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true, firstServe: 'home', bestOf: 5,
        homeShortName: 'NORTH', awayShortName: 'SOUTH',
        bench_home: [{ role: 'Coach' }],
        bench_away: [{ role: 'Coach', firstName: 'Ola', lastName: 'Southcoach' }]
      },
      homeTeam: { name: 'North Club', shortName: 'NORTH', color: '#e2001a' },
      awayTeam: { name: 'South Club', shortName: 'SOUTH', color: '#1d4ed8' },
      homePlayers: [1, 2, 3, 4, 5, 6, 7].map(number => ({ number })),
      awayPlayers: [11, 12, 13, 14, 15, 16, 17].map(number => ({ id: number, number, firstName: 'Eli', lastName: `South${number}` })),
      sets: [{ index: 1, homePoints: 0, awayPoints: 0, finished: false }],
      events: [
        { id: 1, type: 'lineup', setIndex: 1, seq: 1, payload: { team: 'home', isInitial: true, lineup: lineup(1) } },
        { id: 2, type: 'lineup', setIndex: 1, seq: 2, payload: { team: 'away', isInitial: true, lineup: lineup(11) } }
      ]
    }
    const { container } = render(<MatchEntry matchId="m1" team="away" onBack={() => {}} embedded />)
    await waitFor(() => expect(container.querySelector('[data-bench-row="players"]')).not.toBeNull())
    const players = container.querySelector('[data-bench-row="players"]').textContent
    expect(players).toContain('#17')
    expect(players).not.toContain('#7')
    const officials = container.querySelector('[data-bench-row="officials"]').textContent
    expect(officials).toContain('C')
    expect(container.textContent).not.toContain('Southcoach')
    expect(container.textContent).not.toContain('South17')
  })
})
