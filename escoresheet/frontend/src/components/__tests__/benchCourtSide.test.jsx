import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'

// The bench tablet draws its own team's half court with the net on the side
// facing the other team: the side the scorer's court has it on (domain/rules
// getSideAForSet). It used its own rule: team A on the right in every set
// from 2 to 4 (set 3 is A's left) and no set's override.

let bundle = null
vi.mock('../../utils/serverDataSync', () => ({ getMatchData: vi.fn(async () => bundle) }))
vi.mock('../../hooks/useRealtimeConnection', () => ({ useRealtimeConnection: () => ({}) }))
vi.mock('../../db/db', () => ({ db: { matches: { get: vi.fn(async () => null), update: vi.fn(async () => 0) } } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k, d, o) => (typeof d === 'string' ? d : (o?.defaultValue || k)), i18n: { language: 'en' } }) }))

const { default: MatchEntry } = await import('../MatchEntry.jsx')

// Team A is home; the current set `index` under way
function benchBundle(index, match = {}) {
  const players = (list) => list.map(number => ({ number, firstName: 'A', lastName: `P${number}` }))
  const sets = []
  // the finished sets won in turn (2:2 before set 5)
  for (let i = 1; i < index; i++) sets.push({ index: i, homePoints: i % 2 ? 25 : 20, awayPoints: i % 2 ? 20 : 25, finished: true })
  sets.push({ index, homePoints: 3, awayPoints: 2, finished: false })
  return {
    success: true,
    match: { id: 'm1', status: 'live', coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home', bestOf: 5, ...match },
    homeTeam: { name: 'Home', color: '#e2001a' },
    awayTeam: { name: 'Away', color: '#3b82f6' },
    homePlayers: players([1, 10, 88, 14, 99, 12]),
    awayPlayers: players([2, 11, 55, 66, 98, 13]),
    sets,
    events: [
      { type: 'lineup', setIndex: index, ts: 1, payload: { team: 'home', lineup: { I: 10, II: 88, III: 14, IV: 99, V: 12, VI: 1 } } },
      { type: 'lineup', setIndex: index, ts: 1, payload: { team: 'away', lineup: { I: 2, II: 11, III: 55, IV: 66, V: 98, VI: 13 } } }
    ]
  }
}

async function benchSide(team) {
  const { container } = render(<MatchEntry matchId="m1" team={team} onBack={() => {}} embedded />)
  await waitFor(() => expect(container.querySelectorAll('.court-player').length).toBe(6))
  const half = container.querySelector('.court-side')
  return half.classList.contains('court-side-left') ? 'left' : 'right'
}

describe('bench tablet: its team\'s side of the court is the scorer\'s', () => {
  beforeEach(() => { cleanup(); bundle = null })

  it('sets 1-4 alternate: team A left in sets 1 and 3, right in 2 and 4', async () => {
    for (const [index, side] of [[1, 'left'], [2, 'right'], [3, 'left'], [4, 'right']]) {
      bundle = benchBundle(index)
      expect(await benchSide('home'), `set ${index}`).toBe(side)
      cleanup()
      expect(await benchSide('away'), `set ${index}`).toBe(side === 'left' ? 'right' : 'left')
      cleanup()
    }
  })

  it('a set\'s override (the left team A/B)', async () => {
    bundle = benchBundle(2, { setLeftTeamOverrides: { 2: 'A' } })
    expect(await benchSide('home')).toBe('left')
  })

  it('set 5: its coin toss, flipped at the change of courts at 8', async () => {
    bundle = benchBundle(5, { set5LeftTeam: 'A' })
    expect(await benchSide('home')).toBe('left')
    cleanup()
    bundle = benchBundle(5, { set5LeftTeam: 'A', set5CourtSwitched: true })
    expect(await benchSide('home')).toBe('right')
  })
})
