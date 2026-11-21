import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'

// The bench's sanctions box (full-match test 2026-11-21, 26.11.2):
// - a coach's warning was listed twice ("Coach, Coach"): once by the
//   officials row, once more as a team sanction;
// - in the interval between two sets (no set under way) it said "None";
// - a player an exceptional substitution took off the court (home #11,
//   expelled with no legal substitute) lost his sanction, which the referee
//   still showed.
// It lists the team's sanction events of the match, once each, in the order
// the scorer recorded them, whoever is on the court now.

let bundle = null
vi.mock('../../utils/serverDataSync', () => ({ getMatchData: vi.fn(async () => bundle), addRelayMessageListener: () => () => {}, sendRelayMessage: () => false }))
vi.mock('../../hooks/useRealtimeConnection', () => ({ useRealtimeConnection: () => ({}) }))
vi.mock('../../db/db', () => ({ db: { matches: { get: vi.fn(async () => null), update: vi.fn(async () => 0) } } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k, d, o) => (typeof d === 'string' ? d : (o?.defaultValue || k)), i18n: { language: 'en' } }) }))

const { default: MatchEntry } = await import('../MatchEntry.jsx')

const players = (list) => list.map(number => ({ number, firstName: 'A', lastName: `P${number}` }))
let seq = 0
const ev = (type, setIndex, payload) => ({ id: ++seq, seq, type, setIndex, ts: seq, payload })
const lineup = (team, setIndex, l) => ev('lineup', setIndex, { team, lineup: l })
const sanction = (team, setIndex, payload) => ev('sanction', setIndex, { team, ...payload })

function benchBundle({ sets, events, match = {} }) {
  return {
    success: true,
    match: {
      id: 'm1', status: 'live', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true, firstServe: 'home', bestOf: 5,
      bench_home: [{ role: 'Coach', lastName: 'Boss' }, { role: 'Assistant Coach 1', lastName: 'One' }],
      ...match
    },
    homeTeam: { name: 'Home', color: '#e2001a' },
    awayTeam: { name: 'Away', color: '#3b82f6' },
    homePlayers: players([1, 10, 88, 14, 99, 12, 7, 11]),
    awayPlayers: players([2, 21, 55, 66, 98, 13]),
    sets,
    events
  }
}
const home1 = { I: 10, II: 88, III: 14, IV: 99, V: 12, VI: 1 }

const listOf = (container) => [...container.querySelectorAll('[data-bench-sanctions] li')]
  .map(li => [li.getAttribute('data-bench-sanction'), li.textContent])
const rowText = (container, key) => container.querySelector(`[data-bench-row="${key}"]`)?.textContent || ''

async function renderBench(team = 'home') {
  const view = render(<MatchEntry matchId="m1" team={team} onBack={() => {}} embedded />)
  await waitFor(() => expect(view.container.querySelector('[data-bench-sanctions]')).not.toBeNull())
  return view
}

describe('bench sanctions box: each sanction once', () => {
  beforeEach(() => { cleanup(); bundle = null; seq = 0 })

  it("a coach's warning is listed once, not \"Coach, Coach\"", async () => {
    bundle = benchBundle({
      sets: [{ index: 1, homePoints: 3, awayPoints: 2, finished: false }],
      events: [
        lineup('home', 1, home1),
        sanction('home', 1, { type: 'warning', playerType: 'official', role: 'Coach' })
      ]
    })
    const { container } = await renderBench()
    await waitFor(() => expect(listOf(container).length).toBe(1))
    expect(listOf(container)).toEqual([['warning', 'Coach']])
    // the coach's chip still shows the card
    const coachChip = container.querySelector('[title="Coach"]')
    expect(coachChip.querySelector('[data-card-glyph="warning"]')).not.toBeNull()
  })

  it("an official whose role is not on the team's bench list is listed once", async () => {
    bundle = benchBundle({
      sets: [{ index: 1, homePoints: 3, awayPoints: 2, finished: false }],
      events: [
        lineup('home', 1, home1),
        sanction('home', 1, { type: 'penalty', playerType: 'official', role: 'Physiotherapist' })
      ]
    })
    const { container } = await renderBench()
    await waitFor(() => expect(listOf(container).length).toBe(1))
    expect(listOf(container)).toEqual([['penalty', 'Physiotherapist']])
  })

  it('lists players, officials, delay and improper request in the order they were given', async () => {
    bundle = benchBundle({
      sets: [{ index: 1, homePoints: 3, awayPoints: 2, finished: false }],
      events: [
        lineup('home', 1, home1),
        sanction('home', 1, { type: 'delay_warning' }),
        sanction('home', 1, { type: 'warning', playerType: 'player', playerNumber: '14', position: 'III' }),
        sanction('home', 1, { type: 'penalty', playerType: 'bench', playerNumber: 7 }),
        sanction('home', 1, { type: 'warning', playerType: 'official', role: 'Coach' }),
        sanction('home', 1, { type: 'improper_request' }),
        sanction('away', 1, { type: 'penalty', playerType: 'player', playerNumber: 21 })
      ]
    })
    const { container } = await renderBench()
    await waitFor(() => expect(listOf(container).length).toBe(5))
    expect(listOf(container)).toEqual([
      ['delay_warning', 'D'],
      ['warning', '#14'],
      ['penalty', '#7'],
      ['warning', 'Coach'],
      ['improper_request', 'Improper request']
    ])
  })

  it('the same event twice in the bundle is listed once', async () => {
    const warning = sanction('home', 1, { type: 'warning', playerType: 'official', role: 'Coach' })
    bundle = benchBundle({
      sets: [{ index: 1, homePoints: 3, awayPoints: 2, finished: false }],
      events: [lineup('home', 1, home1), warning, { ...warning }]
    })
    const { container } = await renderBench()
    await waitFor(() => expect(listOf(container).length).toBe(1))
  })
})
