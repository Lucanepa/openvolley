import { describe, it, expect } from 'vitest'
import {
  getStartingLineup,
  getStartingLineupEvent,
  assignSubsToColumns,
  countRegularSubstitutions,
  displaySetNumber,
  getScoreBeforeEvent,
  getSet5LeftTeamLabel,
  getFirstServeTeamKey,
  consistencyWarnings
} from '../scoresheetModel'

const lineup = (team: string, l: Record<string, number>, seq: number, extra: Record<string, unknown> = {}, setIndex = 1) => ({
  type: 'lineup', setIndex, seq, ts: `2026-10-05T18:00:${String(seq).padStart(2, '0')}Z`,
  payload: { team, lineup: l, ...extra }
})
const point = (team: string, seq: number, setIndex = 1, ts?: string) => ({
  type: 'point', setIndex, seq, ts: ts || `2026-10-05T18:01:${String(seq).padStart(2, '0')}Z`, payload: { team }
})

const START = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }

describe('getStartingLineup', () => {
  it('uses the initial lineup, not the latest rotated/substitution/libero lineup', () => {
    const events = [
      lineup('home', START, 1, { isInitial: true }),
      point('away', 2),
      // rotation after side-out: unflagged lineup event
      lineup('home', { I: 2, II: 3, III: 4, IV: 5, V: 6, VI: 1 }, 3),
      // substitution 5 -> 9
      lineup('home', { I: 2, II: 3, III: 4, IV: 9, V: 6, VI: 1 }, 4, { fromSubstitution: true }),
      // libero 12 replaces 6
      lineup('home', { I: 2, II: 3, III: 4, IV: 9, V: 12, VI: 1 }, 5, { liberoSubstitution: { liberoNumber: 12 } })
    ]
    expect(getStartingLineup(events, 1, 'home')).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('honours a re-entered initial lineup (latest isInitial wins)', () => {
    const events = [
      lineup('home', START, 1, { isInitial: true }),
      lineup('home', { ...START, IV: 14 }, 2, { isInitial: true }),
      lineup('home', { I: 2, II: 3, III: 14, IV: 5, V: 6, VI: 1 }, 3)
    ]
    expect(getStartingLineup(events, 1, 'home')).toEqual(['1', '2', '3', '14', '5', '6'])
  })

  it('uses a pre-rally FIVB 7.3.4 rectification (manual lineup, isInitial false)', () => {
    const events = [
      lineup('home', START, 1, { isInitial: true }),
      lineup('home', { ...START, I: 7 }, 2, { isInitial: false }),
      point('home', 3),
      lineup('home', { I: 2, II: 3, III: 4, IV: 5, V: 6, VI: 7 }, 4)
    ]
    expect(getStartingLineup(events, 1, 'home')).toEqual(['7', '2', '3', '4', '5', '6'])
  })

  it('uses a rectification when the set has no points yet', () => {
    const events = [
      lineup('home', START, 1, { isInitial: true }),
      lineup('home', { ...START, III: 13 }, 2, { isInitial: false })
    ]
    expect(getStartingLineup(events, 1, 'home')[2]).toBe('13')
  })

  it('ignores an initial lineup re-entered after the first point (mid-set re-prompt)', () => {
    // e.g. LineupModal reopened in mode 'initial' after a libero redesignation of 3
    const events = [
      lineup('home', START, 1, { isInitial: true }),
      point('away', 2),
      lineup('home', { I: 2, II: 15, III: 4, IV: 5, V: 6, VI: 1 }, 5, { isInitial: true })
    ]
    expect(getStartingLineup(events, 1, 'home')).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('does not count a libero entry or substitution before the first rally', () => {
    const events = [
      lineup('home', START, 1, { isInitial: true }),
      lineup('home', { ...START, V: 12 }, 2.1, { liberoSubstitution: { liberoNumber: 12, playerNumber: 5 } }),
      lineup('home', { ...START, II: 9, V: 12 }, 3.1, { fromSubstitution: true, liberoSubstitution: { liberoNumber: 12 } }),
      lineup('home', { ...START, II: 9 }, 4.1, { fromSubstitution: true, liberoSubstitution: null }),
      point('home', 5)
    ]
    expect(getStartingLineup(events, 1, 'home')).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('falls back to the first initial lineup when every entered lineup comes after a point', () => {
    const events = [
      point('home', 1),
      lineup('home', START, 2, { isInitial: true }),
      lineup('home', { ...START, I: 8 }, 3, { isInitial: true })
    ]
    expect(getStartingLineup(events, 1, 'home')[0]).toBe('1')
  })

  it('orders by seq even when events arrive unsorted', () => {
    const events = [
      lineup('home', { ...START, I: 8 }, 9, { isInitial: true }),
      lineup('home', START, 1, { isInitial: true })
    ]
    expect(getStartingLineup(events, 1, 'home')[0]).toBe('8')
  })

  it('skips an empty initial placeholder lineup', () => {
    const events = [
      lineup('home', START, 1, { isInitial: true }),
      lineup('home', { I: null, II: null, III: null, IV: null, V: null, VI: null } as any, 2, { isInitial: true })
    ]
    expect(getStartingLineup(events, 1, 'home')).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('falls back to the first lineup of the set for legacy data without isInitial', () => {
    const events = [
      lineup('away', START, 1),
      lineup('away', { I: 2, II: 3, III: 4, IV: 5, V: 6, VI: 1 }, 3)
    ]
    expect(getStartingLineup(events, 1, 'away')).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('is scoped to set and team', () => {
    const events = [
      lineup('home', START, 1, { isInitial: true }, 1),
      lineup('home', { ...START, I: 11 }, 50, { isInitial: true }, 2),
      lineup('away', { ...START, I: 21 }, 2, { isInitial: true }, 1)
    ]
    expect(getStartingLineup(events, 2, 'home')[0]).toBe('11')
    expect(getStartingLineup(events, 1, 'away')[0]).toBe('21')
    expect(getStartingLineup(events, 3, 'home')).toEqual(['', '', '', '', '', ''])
    expect(getStartingLineupEvent(events, 3, 'home')).toBeUndefined()
  })
})

describe('assignSubsToColumns', () => {
  it('keeps an open substitution in the starter column after rotations', () => {
    // 5 (position V) went out for 9 and never came back; the team has rotated since.
    const events = [
      lineup('home', START, 1, { isInitial: true }),
      lineup('home', { I: 2, II: 3, III: 4, IV: 9, V: 6, VI: 1 }, 4, { fromSubstitution: true }),
      lineup('home', { I: 3, II: 4, III: 9, IV: 6, V: 1, VI: 2 }, 7)
    ]
    const subs = new Map([[5, [{ playerOut: 5, playerIn: 9, score: '3:4', isCircled: false }]]])
    const columns = assignSubsToColumns(subs, getStartingLineup(events, 1, 'home'))
    expect(columns[4]).toEqual([{ playerOut: 5, playerIn: 9, score: '3:4', isCircled: false }])
    expect(columns.filter(c => c.length > 0)).toHaveLength(1)
  })

  it('draws a later substitution of a rectified-in starter in its column', () => {
    // 7 replaced 1 at position I through a pre-rally rectification; later 7 -> 10.
    const events = [
      lineup('home', START, 1, { isInitial: true }),
      lineup('home', { ...START, I: 7 }, 2, { isInitial: false }),
      point('away', 3),
      lineup('home', { I: 2, II: 3, III: 4, IV: 5, V: 6, VI: 7 }, 4),
      lineup('home', { I: 2, II: 3, III: 4, IV: 5, V: 6, VI: 10 }, 6.1, { fromSubstitution: true })
    ]
    const subs = new Map([[7, [{ playerOut: 7, playerIn: 10, score: '0:2', isCircled: false }]]])
    const columns = assignSubsToColumns(subs, getStartingLineup(events, 1, 'home'))
    expect(columns[0]).toEqual([{ playerOut: 7, playerIn: 10, score: '0:2', isCircled: false }])
  })

  it('ignores subs for numbers not in the starting lineup and empty slots', () => {
    const subs = new Map([[42, [{ playerOut: 42, playerIn: 9 }]]])
    expect(assignSubsToColumns(subs, ['1', '', '3', '4', '5', '6'])).toEqual([[], [], [], [], [], []])
  })
})

describe('countRegularSubstitutions', () => {
  it('excludes exceptional substitutions', () => {
    const subs = Array.from({ length: 6 }, (_, i) => ({ type: 'substitution', payload: { team: 'home', playerOut: i + 1, playerIn: i + 10 } }))
    const events = [
      ...subs,
      { type: 'substitution', payload: { team: 'home', playerOut: 3, playerIn: 17, isExceptional: true } },
      { type: 'substitution', payload: { team: 'away', playerOut: 3, playerIn: 17 } },
      { type: 'timeout', payload: { team: 'home' } }
    ]
    expect(countRegularSubstitutions(events, 'home')).toBe(6)
    expect(countRegularSubstitutions(events, 'away')).toBe(1)
  })
})

describe('displaySetNumber', () => {
  it('prints the best-of-3 deciding set (index 5) as set 3', () => {
    expect(displaySetNumber(5, 3)).toBe(3)
    expect(displaySetNumber(2, 3)).toBe(2)
  })
  it('leaves best-of-5 and missing bestOf unchanged', () => {
    expect(displaySetNumber(5, 5)).toBe(5)
    expect(displaySetNumber(5, undefined)).toBe(5)
    expect(displaySetNumber(3, undefined)).toBe(3)
  })
})

describe('getScoreBeforeEvent', () => {
  it('counts points by seq, not timestamp', () => {
    // Point seq 3 carries a later ts (e.g. edited / clock skew) but comes before the sanction.
    const sanction = { type: 'sanction', setIndex: 1, seq: 4, ts: '2026-10-05T18:01:00Z', payload: { team: 'home', type: 'penalty' } }
    const events = [
      point('home', 1, 1, '2026-10-05T18:00:10Z'),
      point('away', 2, 1, '2026-10-05T18:00:20Z'),
      point('away', 3, 1, '2026-10-05T18:05:00Z'),
      sanction,
      // the penalty point itself comes after the sanction
      point('away', 5, 1, '2026-10-05T18:00:30Z')
    ]
    expect(getScoreBeforeEvent(events, sanction)).toEqual({ home: 1, away: 2 })
  })

  it('only counts points of the same set', () => {
    const sanction = { type: 'sanction', setIndex: 2, seq: 10, payload: { team: 'away' } }
    const events = [point('home', 1, 1), point('home', 2, 1), point('away', 9, 2), sanction]
    expect(getScoreBeforeEvent(events, sanction)).toEqual({ home: 0, away: 1 })
  })

  it('falls back to timestamps when seq is missing', () => {
    const sanction = { type: 'sanction', setIndex: 1, ts: '2026-10-05T18:00:15Z', payload: { team: 'home' } }
    const events = [
      { type: 'point', setIndex: 1, ts: '2026-10-05T18:00:10Z', payload: { team: 'home' } },
      { type: 'point', setIndex: 1, ts: '2026-10-05T18:00:20Z', payload: { team: 'home' } },
      sanction
    ]
    expect(getScoreBeforeEvent(events, sanction)).toEqual({ home: 1, away: 0 })
  })
})

describe('getSet5LeftTeamLabel', () => {
  it('uses the stored deciding-set toss', () => {
    expect(getSet5LeftTeamLabel({ set5LeftTeam: 'A' })).toBe('A')
    expect(getSet5LeftTeamLabel({ set5LeftTeam: 'B' })).toBe('B')
  })
  it('falls back to Team B on the left like Scoreboard (teams switched as in set 2/4)', () => {
    expect(getSet5LeftTeamLabel({})).toBe('B')
    expect(getSet5LeftTeamLabel(undefined)).toBe('B')
  })
})

describe('getFirstServeTeamKey', () => {
  const A = 'away' as const
  const B = 'home' as const
  it('alternates sets 1-4 from the coin toss', () => {
    const m = { coinTossServeA: true }
    expect(getFirstServeTeamKey(1, m, A, B)).toBe(A)
    expect(getFirstServeTeamKey(2, m, A, B)).toBe(B)
    expect(getFirstServeTeamKey(3, m, A, B)).toBe(A)
    expect(getFirstServeTeamKey(4, m, A, B)).toBe(B)
    expect(getFirstServeTeamKey(1, { coinTossServeA: false }, A, B)).toBe(B)
  })
  it('uses set5FirstServe for the deciding set', () => {
    expect(getFirstServeTeamKey(5, { coinTossServeA: true, set5FirstServe: 'B' }, A, B)).toBe(B)
    expect(getFirstServeTeamKey(5, { coinTossServeA: false, set5FirstServe: 'A' }, A, B)).toBe(A)
  })
  it('falls back to the set 1 server for the deciding set (never blindly Team B)', () => {
    expect(getFirstServeTeamKey(5, { coinTossServeA: true }, A, B)).toBe(A)
    expect(getFirstServeTeamKey(5, { coinTossServeA: false }, A, B)).toBe(B)
  })
  it('falls back to match.firstServe when the coin-toss flag is missing', () => {
    expect(getFirstServeTeamKey(1, { firstServe: 'away' }, A, B)).toBe('away')
    expect(getFirstServeTeamKey(2, { firstServe: 'away' }, A, B)).toBe('home')
  })
})

describe('consistencyWarnings (field-spec 12.2)', () => {
  let s = 0
  const e = (type: string, setIndex: number, payload: Record<string, unknown>) => ({ type, setIndex, seq: ++s, payload })

  it('lists over-limit substitutions and time-outs, wrong totals and unknown starters', () => {
    s = 0
    const events = [
      e('lineup', 1, { team: 'home', lineup: { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 99 }, isInitial: true }),
      ...Array.from({ length: 7 }, (_, i) => e('substitution', 1, { team: 'home', playerOut: i + 1, playerIn: 10 + i, position: 'I' })),
      e('substitution', 1, { team: 'home', playerOut: 2, playerIn: 20, position: 'II', isExceptional: true }),
      ...Array.from({ length: 3 }, () => e('timeout', 1, { team: 'away' })),
      e('point', 1, { team: 'home' })
    ]
    const sets = [{ index: 1, homePoints: 2, awayPoints: 0 }]
    const homePlayers = [1, 2, 3, 4, 5, 6].map(number => ({ number }))
    expect(consistencyWarnings({ sets, events, teamAKey: 'home', homePlayers, awayPlayers: [] })).toEqual([
      'Set 1: the points recorded (1:0, home:away) do not match the set score (2:0).',
      'Set 1, Team A: 7 regular substitutions (at most 6).',
      'Set 1, Team A: starting player 99 not on the roster.',
      'Set 1, Team B: 3 time-outs (at most 2).'
    ])
  })

  it('a clean match has no warning', () => {
    expect(consistencyWarnings({ sets: [{ index: 1, homePoints: 0, awayPoints: 0 }], events: [], teamAKey: 'home' })).toEqual([])
  })
})
