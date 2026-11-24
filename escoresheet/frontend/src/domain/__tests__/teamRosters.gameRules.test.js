import { describe, it, expect } from 'vitest'
import { gameRosterBody } from '../teamRosters'

// A game roster's player counts (owner 2026-11-11; FIVB 19.1.1 / Swiss Volley
// Art. 75a, as Match Setup): more than 12 only with two liberos, at most 14,
// at most 2 liberos; fewer than 6 besides the liberos is a warning.
const roster = (n, liberos = 0) => ({
  players: Array.from({ length: n }, (_, i) => ({ key: `p${i}`, number: i + 1, first_name: 'P', last_name: `N${i}`, is_libero: i < liberos, is_captain: false, picked: true })),
  staff: []
})
const keys = (list) => list.map((x) => x.key.split('.').pop())

describe('gameRosterBody: player counts', () => {
  it('12 without a libero, 12 with one, 14 with two: fine', () => {
    for (const [n, l] of [[12, 0], [12, 1], [13, 2], [14, 2], [6, 0], [7, 1]]) {
      const r = gameRosterBody(roster(n, l))
      expect(r.problems, `${n}/${l}`).toEqual([])
      expect(r.warnings, `${n}/${l}`).toEqual([])
    }
  })
  it('13 without a libero or with one: an error (two liberos needed)', () => {
    expect(keys(gameRosterBody(roster(13, 0)).problems)).toEqual(['twoLiberos'])
    expect(keys(gameRosterBody(roster(13, 1)).problems)).toEqual(['twoLiberos'])
  })
  it('15 players, 3 liberos: errors', () => {
    expect(keys(gameRosterBody(roster(15, 2)).problems)).toEqual(['tooMany'])
    expect(keys(gameRosterBody(roster(10, 3)).problems)).toEqual(['liberos'])
  })
  it('fewer than 6 besides the liberos: a warning, not an error', () => {
    const r = gameRosterBody(roster(7, 2))
    expect(r.problems).toEqual([])
    expect(r.warnings).toEqual([{ key: 'manage.myTeams.problems.fewPlayers', params: { min: 6, count: 5 } }])
    expect(gameRosterBody(roster(0)).warnings).toEqual([])
  })
})
