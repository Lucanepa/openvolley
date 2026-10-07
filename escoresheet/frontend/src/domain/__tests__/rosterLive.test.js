import { describe, it, expect } from 'vitest'
import {
  positionsByNumber,
  hasLineup,
  scoreAtEvent,
  teamSanctionSummary,
  playerPlayStatus,
  gameCaptainOnCourt,
  compareEvents
} from '../rosterLive'

const point = (team, setIndex, seq) => ({ id: `p${setIndex}-${seq}`, type: 'point', setIndex, seq, payload: { team } })
const sanction = (payload, setIndex, seq) => ({ id: `s${setIndex}-${seq}`, type: 'sanction', setIndex, seq, payload })

describe('positionsByNumber', () => {
  it('maps jersey numbers to court positions', () => {
    expect(positionsByNumber({ I: 7, II: '3', III: 12, IV: 1, V: 9, VI: 4 }))
      .toEqual({ 7: 'I', 3: 'II', 12: 'III', 1: 'IV', 9: 'V', 4: 'VI' })
  })
  it('ignores empty slots and non-position keys', () => {
    expect(positionsByNumber({ I: 7, II: '', III: null, foo: 5 })).toEqual({ 7: 'I' })
  })
  it('handles no lineup', () => {
    expect(positionsByNumber(null)).toEqual({})
    expect(hasLineup(null)).toBe(false)
    expect(hasLineup({ I: '' })).toBe(false)
    expect(hasLineup({ IV: 2 })).toBe(true)
  })
})

describe('compareEvents', () => {
  it('orders by seq, sub-events after their parent', () => {
    expect(compareEvents({ seq: 5 }, { seq: 5.1 })).toBeLessThan(0)
    expect(compareEvents({ seq: 6 }, { seq: 5.1 })).toBeGreaterThan(0)
  })
  it('falls back to time without seq', () => {
    expect(compareEvents({ ts: '2026-01-01T10:00:00Z' }, { ts: '2026-01-01T10:00:01Z' })).toBeLessThan(0)
  })
})

describe('scoreAtEvent', () => {
  const events = [
    point('home', 1, 1), point('away', 1, 2), point('home', 1, 3),
    point('home', 2, 10), point('home', 2, 11)
  ]
  it('counts the points of the same set before the event', () => {
    expect(scoreAtEvent(events, { setIndex: 1, seq: 2.5 })).toEqual({ home: 1, away: 1 })
    expect(scoreAtEvent(events, { setIndex: 1, seq: 4 })).toEqual({ home: 2, away: 1 })
    expect(scoreAtEvent(events, { setIndex: 2, seq: 11.5 })).toEqual({ home: 2, away: 0 })
  })
  it('is 0:0 before the first point', () => {
    expect(scoreAtEvent(events, { setIndex: 2, seq: 9 })).toEqual({ home: 0, away: 0 })
  })
})

describe('teamSanctionSummary', () => {
  const events = [
    point('home', 1, 1), point('away', 1, 2), point('away', 1, 3),
    sanction({ team: 'away', type: 'warning', playerNumber: 7 }, 1, 4),
    sanction({ team: 'away', type: 'delay_warning' }, 1, 5),
    sanction({ team: 'away', type: 'penalty', playerNumber: '7' }, 2, 20),
    sanction({ team: 'away', type: 'warning', role: 'Coach' }, 1, 6),
    sanction({ team: 'away', type: 'improper_request' }, 1, 7),
    sanction({ team: 'home', type: 'expulsion', playerNumber: 4 }, 1, 8)
  ]

  it('splits player, official and team sanctions, in order', () => {
    const s = teamSanctionSummary(events, 'away')
    expect(s.players['7'].map(x => x.type)).toEqual(['warning', 'penalty'])
    expect(s.officials.Coach.map(x => x.type)).toEqual(['warning'])
    expect(s.team.map(x => x.type)).toEqual(['delay_warning', 'improper_request'])
    expect(s.players['4']).toBeUndefined()
  })

  it('records set and score with the sanctioned team first', () => {
    const s = teamSanctionSummary(events, 'away')
    expect(s.players['7'][0]).toMatchObject({ setIndex: 1, own: 2, opp: 1 })
    expect(s.players['7'][1]).toMatchObject({ setIndex: 2, own: 0, opp: 0 })
    const h = teamSanctionSummary(events, 'home')
    expect(h.players['4'][0]).toMatchObject({ type: 'expulsion', own: 1, opp: 2 })
  })

  it('is empty without events', () => {
    expect(teamSanctionSummary(undefined, 'home')).toEqual({ players: {}, officials: {}, team: [] })
  })
})

describe('playerPlayStatus', () => {
  const p = (number, extra = {}) => ({ number, ...extra })

  it('disqualified for the whole match', () => {
    const ev = [sanction({ team: 'home', type: 'disqualification', playerNumber: 5 }, 1, 3)]
    expect(playerPlayStatus(ev, 'home', p(5), 3).out).toBe('disqualified')
    expect(playerPlayStatus(ev, 'away', p(5), 3).out).toBe(null)
  })

  it('expelled only in the set of the expulsion', () => {
    const ev = [sanction({ team: 'home', type: 'expulsion', playerNumber: 5 }, 2, 3)]
    expect(playerPlayStatus(ev, 'home', p(5), 2).out).toBe('expelled')
    expect(playerPlayStatus(ev, 'home', p(5), 3).out).toBe(null)
  })

  it('exceptionally substituted is out for the match', () => {
    const ev = [{ type: 'substitution', setIndex: 1, seq: 4, payload: { team: 'home', playerOut: 8, playerIn: 11, isExceptional: true } }]
    expect(playerPlayStatus(ev, 'home', p(8), 3).out).toBe('exceptional')
    expect(playerPlayStatus(ev, 'home', p(11), 3).out).toBe(null)
  })

  it('injury from an injury substitution, a bench injury or an unable libero', () => {
    const ev = [
      { type: 'substitution', setIndex: 1, seq: 4, payload: { team: 'home', playerOut: 8, playerIn: 11, autoRemark: 'Set 1, Team A, ..., Player #8 substituted due to injury' } },
      { type: 'bench_injury', setIndex: 1, seq: 5, payload: { team: 'home', playerNumber: 14 } },
      { type: 'libero_unable', setIndex: 1, seq: 6, payload: { team: 'home', liberoNumber: 1, reason: 'injury' } }
    ]
    expect(playerPlayStatus(ev, 'home', p(8), 1)).toEqual({ out: null, injured: true })
    expect(playerPlayStatus(ev, 'home', p(14), 1)).toEqual({ out: null, injured: true })
    expect(playerPlayStatus(ev, 'home', p(1, { libero: 'libero1' }), 1)).toEqual({ out: 'unable', injured: true })
  })

  it('a libero re-designated away is unable', () => {
    expect(playerPlayStatus([], 'home', p(2, { libero: 'unable' }), 1).out).toBe('unable')
  })

  it('nothing for a clean player', () => {
    expect(playerPlayStatus([], 'home', p(3), 1)).toEqual({ out: null, injured: false })
  })
})

describe('gameCaptainOnCourt', () => {
  const players = [{ number: 1, isCaptain: true }, { number: 2 }, { number: 3 }]
  const lineup = { I: 2, II: 3, III: 4, IV: 5, V: 6, VI: 7 }

  it('is the designated court captain when the captain is off court', () => {
    expect(gameCaptainOnCourt(players, lineup, 3)).toBe('3')
  })
  it('is none when the team captain is on court', () => {
    expect(gameCaptainOnCourt(players, { ...lineup, I: 1 }, 3)).toBe(null)
  })
  it('is none when no one is designated or the designee left the court', () => {
    expect(gameCaptainOnCourt(players, lineup, null)).toBe(null)
    expect(gameCaptainOnCourt(players, lineup, 9)).toBe(null)
  })
})
