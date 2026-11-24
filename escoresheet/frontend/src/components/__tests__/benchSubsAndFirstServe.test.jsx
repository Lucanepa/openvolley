// The bench header: substitutions count toward the 6 without the exceptional
// ones, and before the first point the serve ball follows the set's first
// serve (it alternates), not the match's first serve in every set.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'

let bundle = null
vi.mock('../../utils/serverDataSync', () => ({ getMatchData: vi.fn(async () => bundle), addRelayMessageListener: () => () => {}, sendRelayMessage: () => false }))
vi.mock('../../hooks/useRealtimeConnection', () => ({ useRealtimeConnection: () => ({}) }))
vi.mock('../../db/db', () => ({ db: { matches: { get: vi.fn(async () => null), update: vi.fn(async () => 0) } } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k, d, o) => (typeof d === 'string' ? d : (o?.defaultValue || k)), i18n: { language: 'en' } }) }))

const { default: MatchEntry } = await import('../MatchEntry.jsx')

const players = (list) => list.map(number => ({ number, firstName: 'A', lastName: `P${number}` }))
const base = (sets, events) => ({
  success: true,
  match: { id: 'm1', status: 'live', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true, firstServe: 'home', bestOf: 5 },
  homeTeam: { name: 'VBC Musterdorf', color: '#e2001a' },
  awayTeam: { name: 'Volley Beispiel', color: '#3b82f6' },
  homePlayers: players([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  awayPlayers: players([21, 22, 23, 24, 25, 26]),
  sets,
  events
})
const lineup = (team, setIndex, seq) => ({ type: 'lineup', setIndex, seq, payload: { team, lineup: team === 'home' ? { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 } : { I: 21, II: 22, III: 23, IV: 24, V: 25, VI: 26 } } })

describe('bench header', () => {
  beforeEach(() => { cleanup(); bundle = null })

  // owner 22.11.2026: "SUB shall count exceptional substitutions"; the
  // colour and the pips follow the regular ones (the 6 of the rule)
  const subsOf = (count, exceptionalAt) => Array.from({ length: count }, (_, i) => ({ type: 'substitution', setIndex: 1, seq: 10 + i, payload: { team: 'home', playerOut: i + 1, playerIn: 30 + i, ...(exceptionalAt.includes(i) ? { isExceptional: true } : {}) } }))
  const subCounter = (container) => container.querySelector('[data-bench-counter="sub"]')
  // a filled pip has the ink as its background, an empty one none
  const filledPips = (counter) => [...counter.querySelectorAll('span[aria-hidden="true"] > span')].filter(p => /background: var\(/.test(p.getAttribute('style'))).length

  it('counts every substitution, exceptional ones included: 5 regular + 1 exceptional read 6 /6, amber, 5 pips', async () => {
    bundle = base([{ index: 1, homePoints: 3, awayPoints: 2, finished: false }], [lineup('home', 1, 1), lineup('away', 1, 2), ...subsOf(6, [5])])
    const { container } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(subCounter(container)).not.toBeNull())
    expect(subCounter(container).textContent).toContain('6/6')
    expect(subCounter(container).getAttribute('data-tone')).toBe('near')
    expect(filledPips(subCounter(container))).toBe(5)
  })

  it('6 regular + 1 exceptional read 7 /6, red, all 6 pips filled', async () => {
    bundle = base([{ index: 1, homePoints: 3, awayPoints: 2, finished: false }], [lineup('home', 1, 1), lineup('away', 1, 2), ...subsOf(7, [6])])
    const { container } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(subCounter(container)).not.toBeNull())
    expect(subCounter(container).textContent).toContain('7/6')
    expect(subCounter(container).getAttribute('data-tone')).toBe('max')
    expect(filledPips(subCounter(container))).toBe(6)
  })

  it('set 2 before its first point: the other team serves first', async () => {
    bundle = base([{ index: 1, homePoints: 25, awayPoints: 20, finished: true }, { index: 2, homePoints: 0, awayPoints: 0, finished: false }], [lineup('home', 2, 1), lineup('away', 2, 2)])
    const { container } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(container.querySelector('[data-bench-set]')?.textContent).toBe('2'))
    await waitFor(() => expect(container.querySelector('[data-bench-serve]')).not.toBeNull())
    expect(container.querySelector('[data-bench-serve]').getAttribute('data-bench-serve')).toBe('opp')
  })
})
