import { describe, it, expect } from 'vitest'
import { buildSetData, eventsBySet, type SetContext } from '../setModel'

// The riskiest logic of the drawn sets, tested on the pure model (review
// 2026-11-16, F8): returning substitutes, the deciding set's substitutions and
// time-outs across the change of courts, penalty points without penaltySeq.

const HOME = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }
const AWAY = { I: 11, II: 12, III: 13, IV: 14, V: 15, VI: 16 }

function setup(setIndex: number) {
  let seq = 0
  const events: any[] = []
  const ev = (type: string, payload: Record<string, unknown> = {}) => {
    seq += 1
    events.push({ type, setIndex, seq, ts: new Date(Date.UTC(2026, 10, 16, 18, 0, seq)).toISOString(), payload })
  }
  ev('lineup', { team: 'home', lineup: HOME, isInitial: true })
  ev('lineup', { team: 'away', lineup: AWAY, isInitial: true })
  const score = { home: 0, away: 0 }
  const point = (team: 'home' | 'away', payload: Record<string, unknown> = {}) => { score[team] += 1; ev('point', { team, ...payload }) }
  const points = (team: 'home' | 'away', n: number) => { for (let i = 0; i < n; i++) point(team) }
  const data = () => {
    const sets = [{ index: setIndex, homePoints: score.home, awayPoints: score.away, finished: false, startTime: '2026-11-16T18:00:00.000Z' }]
    const ctx: SetContext = {
      match: { coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false, set5LeftTeam: 'A', set5FirstServe: 'A' },
      sets, teamAKey: 'home', teamBKey: 'away', set5SwitchAt: 8, eventsOfSet: eventsBySet(events)
    }
    return buildSetData(ctx, setIndex, false)
  }
  return { ev, point, points, data }
}

const column = (subs: any[][], starterIndex: number) => subs[starterIndex].map(s => ({ out: s.playerOut, in: s.playerIn, score: s.score, circled: !!s.isCircled }))

describe('substitutions', () => {
  it('a return substitution of the left team: the substitute circled, the return in row 2 of the starter\'s column', () => {
    const s = setup(1)
    s.points('home', 2); s.points('away', 1)
    s.ev('substitution', { team: 'home', playerOut: 5, playerIn: 9, position: 'V' })
    s.points('away', 3)
    s.ev('substitution', { team: 'home', playerOut: 9, playerIn: 5, position: 'V' })
    const d = s.data()
    expect(column(d.leftSubs, 4)).toEqual([
      { out: 5, in: 9, score: '2:1', circled: true },
      { out: 9, in: 5, score: '2:4', circled: false }
    ])
  })

  it('a return substitution of the right team, the same way', () => {
    const s = setup(1)
    s.points('away', 1)
    s.ev('substitution', { team: 'away', playerOut: 13, playerIn: 7, position: 'III' })
    s.points('home', 2)
    s.ev('substitution', { team: 'away', playerOut: 7, playerIn: 13, position: 'III' })
    const d = s.data()
    expect(column(d.rightSubs, 2)).toEqual([
      { out: 13, in: 7, score: '1:0', circled: true },
      { out: 7, in: 13, score: '1:2', circled: false }
    ])
  })

  it('an exceptional substitution is not drawn in the grid (it goes to the remarks)', () => {
    const s = setup(1)
    s.ev('substitution', { team: 'home', playerOut: 3, playerIn: 17, position: 'III', isExceptional: true })
    expect(s.data().leftSubs.flat()).toEqual([])
  })

  it('deciding set: a substitution before the change and its return after it', () => {
    const s = setup(5)
    s.points('home', 3); s.points('away', 2)
    s.ev('substitution', { team: 'home', playerOut: 5, playerIn: 9, position: 'V' })
    s.points('away', 6) // away reaches 8: the change of courts
    s.point('home')
    s.ev('substitution', { team: 'home', playerOut: 9, playerIn: 5, position: 'V' })
    const d = s.data()
    // panel 1: the substitution only, not circled (its return is in panel 3)
    expect(column(d.leftSubs, 4)).toEqual([{ out: 5, in: 9, score: '3:2', circled: false }])
    // panel 3: both, the substitute circled there
    expect(column(d.leftSubs_After!, 4)).toEqual([
      { out: 5, in: 9, score: '3:2', circled: true },
      { out: 9, in: 5, score: '4:8', circled: false }
    ])
    expect(d.leftScoreAtCourtChange).toBe(3)
  })

  it('deciding set: no change of courts yet, panel 3 stays empty', () => {
    const s = setup(5)
    s.points('home', 3)
    s.ev('substitution', { team: 'home', playerOut: 5, playerIn: 9, position: 'V' })
    const d = s.data()
    expect(d.leftSubs_After!.flat()).toEqual([])
    expect(d.leftTimeouts_After).toEqual(['', ''])
    expect(d.leftScoreAtCourtChange).toBeNull()
    expect(d.set5ChangeAt).toBeNull()
  })
})

describe('time-outs in the deciding set', () => {
  it('3:2 in panel 1, 9:8 after the change: panel 3 lists both', () => {
    const s = setup(5)
    s.points('home', 3); s.points('away', 2)
    s.ev('timeout', { team: 'home' })
    s.points('home', 5) // home reaches 8
    s.points('home', 1); s.points('away', 6)
    s.ev('timeout', { team: 'home' })
    const d = s.data()
    expect(d.leftTimeouts).toEqual(['3:2', ''])
    expect(d.leftTimeouts_After).toEqual(['3:2', '9:8'])
  })

  it('the right team\'s time-out is written with its own score first', () => {
    const s = setup(5)
    s.points('home', 4); s.points('away', 1)
    s.ev('timeout', { team: 'away' })
    expect(s.data().rightTimeouts).toEqual(['1:4', ''])
  })
})

describe('penalty points', () => {
  it('a penalty without penaltySeq (older logs): the opponent\'s next point is circled', () => {
    const s = setup(1)
    s.points('home', 2); s.points('away', 3)
    s.ev('sanction', { team: 'home', type: 'penalty', playerNumber: 4 })
    s.points('home', 1) // not the opponent: not circled
    s.points('away', 1) // the opponent's next point: circled (4)
    const d = s.data()
    expect(d.rightCircledPoints).toEqual([4])
    expect(d.leftCircledPoints).toEqual([])
    expect(d.rightMarkedPoints).toEqual([1, 2, 3, 4])
  })

  it('a delay penalty circles the opponent\'s next point the same way', () => {
    const s = setup(1)
    s.points('away', 1)
    s.ev('sanction', { team: 'away', type: 'delay_penalty' })
    s.points('home', 1)
    expect(s.data().leftCircledPoints).toEqual([1])
  })

  it('a warning circles nothing', () => {
    const s = setup(1)
    s.ev('sanction', { team: 'away', type: 'warning', playerNumber: 12 })
    s.points('home', 1)
    expect(s.data().leftCircledPoints).toEqual([])
  })

  it('with penaltySeq: the linked point is circled, wherever it is', () => {
    const s = setup(1)
    s.points('home', 1)
    s.ev('sanction', { team: 'home', type: 'penalty', playerNumber: 4 })
    // the sanction got seq 4 (2 line-ups + 1 point before it)
    s.point('away', { penaltySeq: 4 })
    expect(s.data().rightCircledPoints).toEqual([1])
  })

  it('a point awarded by default or by the going back is circled', () => {
    const s = setup(1)
    s.points('home', 2)
    s.point('home', { forfeitAwarded: true })
    s.point('away', { penaltyPoint: true })
    const d = s.data()
    expect(d.leftCircledPoints).toEqual([3])
    expect(d.rightCircledPoints).toEqual([1])
  })
})

describe('the grid of an unplayed set', () => {
  it('no points, no start time: zero points, but the line-ups are still read', () => {
    const s = setup(2)
    const ctx = { match: { coinTossTeamA: 'home' }, sets: [], teamAKey: 'home' as const, teamBKey: 'away' as const, set5SwitchAt: 8, eventsOfSet: () => [] }
    const d = buildSetData(ctx, 2, true)
    expect(d.leftPoints).toBe(0)
    expect(d.rightPoints).toBe(0)
    expect(d.startTime).toBe('')
    expect(s).toBeTruthy()
  })
})
