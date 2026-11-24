import { describe, it, expect } from 'vitest'
import { applyLiveChange, visibleGames } from '../livescoreChanges'

const game = (id, extra = {}) => ({ match_id: id, points_a: 0, points_b: 0, ...extra })

describe('applyLiveChange', () => {
  it('UPDATE merges into the loaded row and keeps the joined set_results', () => {
    const list = [game('a', { matches: { set_results: [{ a: 25, b: 20 }] } }), game('b')]
    const next = applyLiveChange(list, { eventType: 'UPDATE', new: { match_id: 'a', points_a: 3 }, old: {} })
    expect(next[0]).toEqual({ match_id: 'a', points_a: 3, points_b: 0, matches: { set_results: [{ a: 25, b: 20 }] } })
    expect(next[1]).toBe(list[1])
  })

  it('UPDATE for an unknown match is treated as an insert', () => {
    const list = [game('a')]
    const next = applyLiveChange(list, { eventType: 'UPDATE', new: game('new', { points_a: 1 }), old: {} })
    expect(next.map(g => g.match_id)).toEqual(['new', 'a'])
  })

  it('INSERT for a known match does not duplicate it', () => {
    const list = [game('a')]
    const next = applyLiveChange(list, { eventType: 'INSERT', new: game('a', { points_a: 9 }) })
    expect(next).toHaveLength(1)
    expect(next[0].points_a).toBe(9)
  })

  it('DELETE removes by old.match_id', () => {
    const list = [game('a'), game('b')]
    expect(applyLiveChange(list, { eventType: 'DELETE', new: {}, old: { match_id: 'a' } }).map(g => g.match_id)).toEqual(['b'])
    expect(applyLiveChange(list, { eventType: 'DELETE', new: {}, old: { match_id: 'zz' } })).toBe(list)
  })

  it('ignores probe rows and drops a game that turns into one', () => {
    const list = [game('a')]
    expect(applyLiveChange(list, { eventType: 'INSERT', new: game('p', { match_status: 'probe' }) })).toBe(list)
    expect(applyLiveChange(list, { eventType: 'UPDATE', new: game('a', { match_status: 'probe' }) })).toEqual([])
    expect(visibleGames([game('a'), game('p', { match_status: 'probe' }), null])).toEqual([game('a')])
  })

  it('ignores malformed payloads', () => {
    const list = [game('a')]
    expect(applyLiveChange(list, null)).toBe(list)
    expect(applyLiveChange(list, { eventType: 'UPDATE', new: {} })).toBe(list)
    expect(applyLiveChange(list, { eventType: 'TRUNCATE' })).toBe(list)
  })
})
