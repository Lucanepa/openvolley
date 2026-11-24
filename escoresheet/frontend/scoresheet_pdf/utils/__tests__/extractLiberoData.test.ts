import { describe, it, expect } from 'vitest'
import { extractLiberoData, getHeaderLiberos, rosterLiberos } from '../extractLiberoData'

const players = (list: Array<[number, string | undefined]>) =>
  list.map(([number, libero]) => ({ number: String(number), name: `P${number}`, libero }))

describe('getHeaderLiberos', () => {
  it('lists libero1 before libero2', () => {
    const p = players([[3, undefined], [14, 'libero2'], [7, 'libero1']])
    expect(getHeaderLiberos(p, [], 'home')).toEqual([
      { number: 7, type: 'libero1' },
      { number: 14, type: 'libero2' }
    ])
  })

  it('keeps a libero that became unable after re-designation, in its registered slot', () => {
    // Scoreboard rewrites L1 #7 to 'unable' and the new libero #3 to 'redesignated'
    const p = players([[3, 'redesignated'], [14, 'libero2'], [7, 'unable']])
    const events = [
      { type: 'libero_unable', setIndex: 2, seq: 40, payload: { team: 'home', liberoNumber: 7, liberoType: 'libero1' } },
      { type: 'libero_redesignation', setIndex: 2, seq: 41, payload: { team: 'home', unableLiberoNumber: 7, unableLiberoType: 'libero1', newLiberoNumber: 3 } }
    ]
    expect(getHeaderLiberos(p, events, 'home')).toEqual([
      { number: 7, type: 'libero1' },
      { number: 14, type: 'libero2' }
    ])
  })

  it('does not lose a one-libero team after re-designation', () => {
    const p = players([[3, 'redesignated'], [7, 'unable']])
    const events = [
      { type: 'libero_redesignation', setIndex: 1, seq: 5, payload: { team: 'away', unableLiberoNumber: 7, unableLiberoType: 'libero1', newLiberoNumber: 3 } }
    ]
    expect(getHeaderLiberos(p, events, 'away').map(l => l.number)).toEqual([7])
    // events of the other team do not leak in
    expect(getHeaderLiberos(p, events, 'home')).toEqual([{ number: 7, type: 'unable' }])
  })
})

describe('rosterLiberos (the roster LIBERO box)', () => {
  const rows = (list: ReturnType<typeof rosterLiberos>) => list.map(l => `${l.number}`)

  it('keeps both registered liberos after both became unable, without the re-designated player', () => {
    const p = players([[1, 'unable'], [7, 'redesignated'], [10, 'unable']])
    const events = [
      { type: 'libero_unable', setIndex: 1, seq: 10, payload: { team: 'home', liberoNumber: 1, liberoType: 'libero1' } },
      { type: 'libero_unable', setIndex: 2, seq: 30, payload: { team: 'home', liberoNumber: 10, liberoType: 'libero2' } },
      { type: 'libero_redesignation', setIndex: 2, seq: 31, payload: { team: 'home', unableLiberoNumber: 10, unableLiberoType: 'libero2', newLiberoNumber: 7 } }
    ]
    // the re-designated #7 is not in the box (remarks, as Genius)
    expect(rows(rosterLiberos(p, events, 'home'))).toEqual(['1', '10'])
  })

  it('a one-libero team re-designated twice: only the registered libero', () => {
    const p = players([[3, 'unable'], [7, 'unable'], [9, 'redesignated']])
    const events = [
      { type: 'libero_redesignation', setIndex: 1, seq: 5, payload: { team: 'away', unableLiberoNumber: 7, unableLiberoType: 'libero1', newLiberoNumber: 3 } },
      { type: 'libero_unable', setIndex: 2, seq: 20, payload: { team: 'away', liberoNumber: 3, liberoType: 'redesignated' } },
      { type: 'libero_redesignation', setIndex: 2, seq: 21, payload: { team: 'away', unableLiberoNumber: 3, unableLiberoType: 'redesignated', newLiberoNumber: 9 } }
    ]
    expect(rows(rosterLiberos(p, events, 'away'))).toEqual(['7'])
  })

  it('no re-designation: the registered liberos in their order', () => {
    const p = players([[3, undefined], [14, 'libero2'], [7, 'libero1']])
    expect(rows(rosterLiberos(p, [], 'home'))).toEqual(['7', '14'])
  })
})

describe('extractLiberoData', () => {
  it('keeps both teams\' header liberos and every redesignation', () => {
    const teamA = players([[7, 'unable'], [3, 'redesignated']])
    const teamB = players([[10, 'libero1']])
    const events = [
      { type: 'libero_redesignation', setIndex: 1, seq: 5, payload: { team: 'home', unableLiberoNumber: 7, unableLiberoType: 'libero1', newLiberoNumber: 3 } },
      { type: 'libero_redesignation', setIndex: 5, seq: 90, payload: { team: 'home', unableLiberoNumber: 3, unableLiberoType: 'redesignated', newLiberoNumber: 9 } }
    ]
    const data = extractLiberoData(events, [], 'home', teamA as any, teamB as any)
    expect(data.teamALiberos.map(l => l.number)).toEqual([7])
    expect(data.teamBLiberos.map(l => l.number)).toEqual([10])
    expect(data.redesignations.map(r => [r.team, r.outNumber, r.inNumber, r.setNumber])).toEqual([
      ['A', 7, 3, 1],
      ['A', 3, 9, 5]
    ])
  })

  it('splits the deciding set at the match\'s own change of courts (a Global set to 10: at 5)', () => {
    const teamA = players([[7, 'libero1']])
    const teamB = players([[10, 'libero1']])
    let seq = 0
    const e = (type: string, payload: Record<string, unknown>) => ({ type, setIndex: 5, seq: ++seq, payload })
    const events = [
      ...Array.from({ length: 5 }, () => e('point', { team: 'home' })),
      // 5:0: past the change at 5 (set to 10), still before 8
      e('libero_entry', { team: 'home', liberoIn: 7, playerOut: 4 })
    ]
    const at = (switchAt?: number) => {
      const set5 = extractLiberoData(events, [], 'home', teamA as any, teamB as any, switchAt).sets.find(s => s.setNumber === 5)!
      return [set5.teamAReplacements.length, (set5.teamAReplacements_After || []).length]
    }
    expect(at()).toEqual([1, 0])
    expect(at(5)).toEqual([0, 1])
  })
})
