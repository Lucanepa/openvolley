import { describe, it, expect } from 'vitest'
import { rallyStatusOf, currentSetOf } from '../rally'

const ev = (type, seq, setIndex = 1, ts = '2026-10-08T10:00:00.000Z') => ({ type, seq, setIndex, ts })

describe('rallyStatusOf', () => {
  it('is in play only when the set\'s last event is a rally_start', () => {
    expect(rallyStatusOf([ev('set_start', 1), ev('rally_start', 2)], 1)).toBe('in_play')
    expect(rallyStatusOf([ev('rally_start', 2), ev('point', 3)], 1)).toBe('idle')
    expect(rallyStatusOf([ev('rally_start', 2), ev('replay', 3)], 1)).toBe('idle')
    expect(rallyStatusOf([ev('point', 3), ev('lineup', 3.1)], 1)).toBe('idle')
    expect(rallyStatusOf([ev('set_start', 1)], 1)).toBe('idle')
    expect(rallyStatusOf([], 1)).toBe('idle')
  })

  it('goes by seq, not by the order of the rows', () => {
    expect(rallyStatusOf([ev('point', 5), ev('rally_start', 4)], 1)).toBe('idle')
    expect(rallyStatusOf([ev('rally_start', 6), ev('point', 5)], 1)).toBe('in_play')
  })

  it('looks at the given set only', () => {
    const events = [ev('rally_start', 9, 1), ev('point', 10, 2)]
    expect(rallyStatusOf(events, 1)).toBe('in_play')
    expect(rallyStatusOf(events, 2)).toBe('idle')
  })

  it('goes by time for events without seq', () => {
    const events = [ev('point', 0, 1, '2026-10-08T10:00:02.000Z'), ev('rally_start', 0, 1, '2026-10-08T10:00:01.000Z')]
    expect(rallyStatusOf(events, 1)).toBe('idle')
  })
})

describe('currentSetOf', () => {
  it('takes the newest row per index, then the first set not finished', () => {
    const sets = [
      { id: 1, index: 1, finished: true },
      { id: 2, index: 2, finished: false },
      { id: 5, index: 2, finished: true },
      { id: 6, index: 3, finished: false }
    ]
    expect(currentSetOf(sets).id).toBe(6)
    expect(currentSetOf([{ id: 1, index: 1, finished: true }]).id).toBe(1)
    expect(currentSetOf([])).toBe(null)
  })
})
