// "Last set's line-up" (owner 2026-11-22): the STARTING line-up of an earlier
// set, as the scoresheet reads it, never the line-up at the end of the set.
import { describe, it, expect } from 'vitest'
import { startingLineupOf, earlierStartingLineups } from '../lineupCopy'

const LU1 = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
const LU2 = { I: 7, II: 8, III: 9, IV: 10, V: 11, VI: 2 }

// Set 1 of home: the starting six, then a point, a rotation, a substitution
// and a libero replacement, each with the line-up row the app writes
const set1 = [
  { seq: 1, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: LU1, isInitial: true } },
  { seq: 2, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: LU2, isInitial: true } },
  { seq: 3, setIndex: 1, type: 'set_start', payload: {} },
  { seq: 4, setIndex: 1, type: 'point', payload: { team: 'home' } },
  { seq: 4.1, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { I: '2', II: '3', III: '4', IV: '5', V: '6', VI: '1' }, fromRotation: true } },
  { seq: 5, setIndex: 1, type: 'substitution', payload: { team: 'home', playerOut: 3, playerIn: 9 } },
  { seq: 5.1, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { I: '2', II: '9', III: '4', IV: '5', V: '6', VI: '1' }, fromSubstitution: true } },
  { seq: 6, setIndex: 1, type: 'libero_entry', payload: { team: 'home', playerOut: 6, liberoIn: 12 } },
  { seq: 6.1, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { I: '2', II: '9', III: '4', IV: '5', V: '12', VI: '1' }, liberoSubstitution: { liberoNumber: 12, playerNumber: 6 } } },
  { seq: 7, setIndex: 1, type: 'set_end', payload: { team: 'home' } }
]

describe('the starting line-up of a set', () => {
  it('is the six entered at the start, not the line-up at the end of the set', () => {
    expect(startingLineupOf(set1, 1, 'home')).toEqual(LU1)
    // numbers as strings, whatever was stored
    expect(startingLineupOf(set1, 1, 'away')).toEqual({ I: '7', II: '8', III: '9', IV: '10', V: '11', VI: '2' })
  })

  it('a correction entered before the first point is the starting line-up', () => {
    const corrected = [...set1, { seq: 3.5, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { ...LU1, III: '10' }, isInitial: false } }]
    expect(startingLineupOf(corrected, 1, 'home').III).toBe('10')
    // after the first point a "Change current lineup" is not the start
    const later = [...set1, { seq: 4.5, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { ...LU1, III: '10' }, isInitial: false } }]
    expect(startingLineupOf(later, 1, 'home')).toEqual(LU1)
  })

  it("reads a bench request's { number } positions, and an old row without the isInitial flag", () => {
    const rows = [{ seq: 1, setIndex: 2, type: 'lineup', payload: { team: 'home', lineup: { I: { number: 4 }, II: 5, III: 6, IV: 7, V: 8, VI: 9 } } }]
    expect(startingLineupOf(rows, 2, 'home')).toEqual({ I: '4', II: '5', III: '6', IV: '7', V: '8', VI: '9' })
    expect(startingLineupOf(rows, 1, 'home')).toBeNull()
  })
})

describe('the earlier sets offered', () => {
  const set2 = [
    { seq: 20, setIndex: 2, type: 'lineup', payload: { team: 'home', lineup: { ...LU1, I: '8' }, isInitial: true } },
    { seq: 21, setIndex: 2, type: 'point', payload: { team: 'away' } }
  ]
  it('the latest first, only before the set being entered, only for the team', () => {
    const list = earlierStartingLineups([...set1, ...set2], 'home', 3)
    expect(list.map(x => x.setIndex)).toEqual([2, 1])
    expect(list[0].lineup.I).toBe('8')
    expect(list[1].lineup).toEqual(LU1)
    expect(earlierStartingLineups([...set1, ...set2], 'home', 2).map(x => x.setIndex)).toEqual([1])
    expect(earlierStartingLineups([...set1, ...set2], 'home', 1)).toEqual([])
    expect(earlierStartingLineups([...set1, ...set2], 'away', 3).map(x => x.setIndex)).toEqual([1])
  })

  it('a best-of-3 decider (index 5) is offered sets 2 and 1', () => {
    expect(earlierStartingLineups([...set1, ...set2], 'home', 5).map(x => x.setIndex)).toEqual([2, 1])
  })
})
