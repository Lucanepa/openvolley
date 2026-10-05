import { describe, it, expect } from 'vitest'
import { extractLiberoData, getHeaderLiberos } from '../extractLiberoData'

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
})
