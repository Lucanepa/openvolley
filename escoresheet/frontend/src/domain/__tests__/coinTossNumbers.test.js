// The coin toss waits until every player of both teams has a shirt number,
// a test match too (domain/coinTossChecks rosterNumberIssues)
import { describe, it, expect } from 'vitest'
import { rosterNumberIssues, playersWithoutNumber } from '../coinTossChecks'

describe('rosterNumberIssues', () => {
  it('names each team with players (liberos too) without a number, with the count', () => {
    const homeRoster = [{ number: 1, lastName: 'A' }, { number: null, lastName: 'B' }, { number: '', lastName: 'C', libero: 'libero1' }]
    const awayRoster = [{ number: 4, lastName: 'D' }]
    expect(rosterNumberIssues({ homeRoster, awayRoster })).toEqual([{ key: 'validation.playersWithoutNumbers', params: { team: 'home', count: 2 } }])
    expect(rosterNumberIssues({ homeRoster: awayRoster, awayRoster: homeRoster })).toEqual([{ key: 'validation.playersWithoutNumbers', params: { team: 'away', count: 2 } }])
    expect(rosterNumberIssues({ homeRoster: awayRoster, awayRoster })).toEqual([])
  })

  it("counts a roster's players without a number", () => {
    expect(playersWithoutNumber([{ number: 0 }, { number: null }, { number: undefined }, { number: '' }, { number: '7' }, { number: 7 }])).toBe(3)
    expect(playersWithoutNumber(undefined)).toBe(0)
  })
})
