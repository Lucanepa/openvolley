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

// The officials row showed the role's first letter: both assistant coaches
// were "A" (emulator 2026-10-14). It shows the paper's codes, as the scorer's
// bench list does, the full role as the tooltip.
describe('bench tablet: the officials row', () => {
  beforeEach(() => { cleanup(); bundle = null })

  it('shows the paper role codes C, AC1, AC2, P, M', async () => {
    bundle = benchBundle(1, {
      bench_home: [
        { role: 'Coach', lastName: 'Boss' },
        { role: 'Assistant Coach 1', lastName: 'One' },
        { role: 'Assistant Coach 2', lastName: 'Two' },
        { role: 'Physiotherapist', lastName: 'Care' },
        { role: 'Doctor', lastName: 'Med' }
      ]
    })
    const { container } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(container.querySelectorAll('[title="Assistant coach 2"]').length).toBe(1))
    const chips = ['Coach', 'Assistant coach 1', 'Assistant coach 2', 'Physiotherapist', 'Doctor']
      .map((title) => container.querySelector(`[title="${title}"]`)?.textContent.trim())
    expect(chips).toEqual(['C', 'AC1', 'AC2', 'P', 'M'])
  })
})

// The scorer stores a sanctioned player's number as text ("14"); the bench
// compared it with the court's number 14 and showed "None" and no card for
// every warning, penalty and disqualification (full-match test 2026-11-09).
describe('bench tablet: player sanctions', () => {
  beforeEach(() => { cleanup(); bundle = null })

  const sanction = (team, playerNumber, type) => ({ type: 'sanction', setIndex: 1, ts: 2, payload: { team, type, playerType: 'player', playerNumber, position: 'III' } })

  it('a warning stored as "14" shows in the list and on the court disc', async () => {
    bundle = benchBundle(1)
    bundle.events.push(sanction('home', '14', 'warning'))
    const { container, getByText } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(container.querySelectorAll('.court-player').length).toBe(6))
    await waitFor(() => expect(getByText('#14')).toBeInTheDocument())
    // the yellow card glyph (referee/SanctionCards.jsx) on #14's disc
    const cards = container.querySelectorAll('.court-player [data-card-glyph="warning"]')
    expect(cards.length).toBe(1)
    expect(cards[0].closest('.court-player').textContent).toContain('14')
  })

  it('the disc shows the most severe card; the list shows each card and to whom', async () => {
    bundle = benchBundle(1)
    bundle.events.push(sanction('home', '14', 'warning'), sanction('home', 14, 'penalty'), sanction('home', '88', 'expulsion'))
    const { container } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(container.querySelectorAll('.court-player').length).toBe(6))
    const discOf = (n) => [...container.querySelectorAll('.court-player')].find(d => d.textContent.includes(String(n)) && d.querySelector('[data-disc-sanction]'))
    await waitFor(() => expect(discOf(14)).toBeTruthy())
    expect(discOf(14).querySelector('[data-disc-sanction]').getAttribute('data-disc-sanction')).toBe('penalty')
    expect(discOf(88).querySelector('[data-disc-sanction]').getAttribute('data-disc-sanction')).toBe('expulsion')
    const list = [...container.querySelectorAll('[data-bench-sanctions] li')].map(li => [li.getAttribute('data-bench-sanction'), li.textContent])
    expect(list).toEqual(expect.arrayContaining([['warning', '#14'], ['penalty', '#14'], ['expulsion', '#88']]))
    // the counters read TO / SUB with the limits
    expect(container.querySelector('[data-bench-counter="to"]').textContent).toBe('TO0/2')
    expect(container.querySelector('[data-bench-counter="sub"]').textContent).toBe('SUB0/6')
  })

  it('a disqualified bench player is listed with the sanction', async () => {
    bundle = benchBundle(1)
    bundle.homePlayers.push({ number: 7, firstName: 'A', lastName: 'P7' })
    bundle.events.push(sanction('home', '7', 'disqualification'))
    const { getAllByText, queryByText } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    // the sanctions box and the bench chip both name #7
    await waitFor(() => expect(getAllByText('#7').length).toBe(2))
    expect(queryByText('None')).toBeNull()
  })

  it('the other team\'s sanction is not shown', async () => {
    bundle = benchBundle(1)
    bundle.events.push(sanction('away', '11', 'penalty'))
    const { container, getByText } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(container.querySelectorAll('.court-player').length).toBe(6))
    expect(getByText('None')).toBeInTheDocument()
  })
})

// The portrait bench (bench-ui-phones, 2026-11-09): the score card names
// both teams (own first) with the serve ball at the serving team, the
// counters carry one pip per request, the liberos sit in the bench row.
describe('bench tablet: the score card, counters and rows', () => {
  beforeEach(() => { cleanup(); bundle = null })

  it('own team first, its serve ball, the set and sets won', async () => {
    bundle = benchBundle(3, { homeShortName: 'MUSTER', awayShortName: 'BEISPIEL' })
    const { container } = render(<MatchEntry matchId="m1" team="away" onBack={() => {}} embedded />)
    await waitFor(() => expect(container.querySelector('[data-bench-points="own"]')).toBeTruthy())
    const text = (sel) => container.querySelector(sel)?.textContent
    expect(text('[data-bench-team="own"]')).toBe('BEISPIEL')
    expect(text('[data-bench-team="opp"]')).toBe('MUSTER')
    expect(text('[data-bench-points="own"]')).toBe('2')
    expect(text('[data-bench-points="opp"]')).toBe('3')
    expect(text('[data-bench-set]')).toBe('3')
    // sets 1 (home 25:20) and 2 (away 25:20) are done
    expect(text('[data-bench-sets="own"]')).toBe('1')
    expect(text('[data-bench-sets="opp"]')).toBe('1')
    // home served first and scored no point since: the ball is the opponent's
    expect(container.querySelector('[data-bench-serve="opp"]')).toBeTruthy()
    expect(container.querySelector('[data-bench-serve="own"]')).toBeNull()
  })

  it('counters: the count, the limit, a red tone when used up', async () => {
    bundle = benchBundle(1)
    bundle.events.push(
      { type: 'timeout', setIndex: 1, seq: 5, payload: { team: 'home' } },
      { type: 'timeout', setIndex: 1, seq: 6, payload: { team: 'home' } }
    )
    const { container } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(container.querySelector('[data-bench-counter="to"]')).toBeTruthy())
    const to = container.querySelector('[data-bench-counter="to"]')
    expect(to.textContent).toContain('2/2')
    expect(to.dataset.tone).toBe('max')
    expect(container.querySelector('[data-bench-counter="sub"]').dataset.tone).toBeUndefined()
  })

  it('the libero off the court is in the bench row', async () => {
    bundle = benchBundle(1)
    bundle.homePlayers.push({ number: 7, firstName: 'L', lastName: 'Libero', libero: 'libero1' })
    const { container } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(container.querySelector('[data-bench-row="players"]')).toBeTruthy())
    const row = container.querySelector('[data-bench-row="players"]')
    expect(row.querySelector('[data-bench-libero]')?.textContent).toContain('#7')
  })
})
