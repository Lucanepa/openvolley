import { describe, it, expect } from 'vitest'
import { officialsToArray, mergeOfficialsEdits, officialsFromSchedule } from '../officials'

const existing = [
  { role: '1st referee', firstName: 'Anna', lastName: 'Muster', country: 'CHE', dob: '01.02.1980' },
  { role: '2nd referee', firstName: 'Ben', lastName: 'Beispiel', country: 'CHE', dob: '' },
  { role: 'scorer', firstName: 'Carl', lastName: 'Schreiber', country: 'ITA', dob: '03.04.1990' },
  { role: 'line judge 1', name: 'Lina' }
]

describe('officialsToArray', () => {
  it('copies an array', () => {
    const arr = officialsToArray(existing)
    expect(arr).toEqual(existing)
    expect(arr).not.toBe(existing)
  })
  it('converts the role-keyed object written by older ManualAdjustments saves', () => {
    const arr = officialsToArray({ ref1: { firstName: 'A', lastName: 'B' }, ref2: { firstName: '', lastName: '' }, asstScorer: { lastName: 'Z' } })
    expect(arr).toEqual([
      { role: '1st referee', firstName: 'A', lastName: 'B' },
      { role: 'assistant scorer', lastName: 'Z' }
    ])
  })
  it('handles nothing', () => {
    expect(officialsToArray(null)).toEqual([])
  })
})

describe('mergeOfficialsEdits', () => {
  it('returns an array and keeps line judges and untouched fields', () => {
    const out = mergeOfficialsEdits(existing, { scorer: { firstName: 'Carla', lastName: 'Schreiber', dob: '03.04.1990' } })
    expect(Array.isArray(out)).toBe(true)
    expect(out.find(o => o.role === 'line judge 1')).toEqual({ role: 'line judge 1', name: 'Lina' })
    const scorer = out.find(o => o.role === 'scorer')
    expect(scorer).toMatchObject({ firstName: 'Carla', lastName: 'Schreiber', country: 'ITA' })
    expect(out.find(o => o.role === '1st referee')).toEqual(existing[0])
    expect(out).toHaveLength(4)
  })

  it('adds a newly named official', () => {
    const out = mergeOfficialsEdits(existing, { asstScorer: { firstName: 'Dora', lastName: 'Hilfe', dob: '' } })
    expect(out.find(o => o.role === 'assistant scorer')).toMatchObject({ firstName: 'Dora', lastName: 'Hilfe', dob: null })
    expect(out).toHaveLength(5)
  })

  it('removes an official whose name was cleared', () => {
    const out = mergeOfficialsEdits(existing, { ref2: { firstName: '', lastName: '', country: '', dob: '' } })
    expect(out.some(o => o.role === '2nd referee')).toBe(false)
  })

  it('matches legacy role spellings and normalises the role', () => {
    const out = mergeOfficialsEdits([{ role: 'ref1', firstName: 'X', lastName: 'Y' }], { ref1: { firstName: 'X', lastName: 'Z' } })
    expect(out).toEqual([{ role: '1st referee', firstName: 'X', lastName: 'Z' }])
  })

  it('snake_case output for the cloud payload', () => {
    const out = mergeOfficialsEdits(existing, { ref1: { firstName: 'Anna', lastName: 'M' } }, { snakeCase: true })
    const ref1 = out.find(o => o.role === '1st referee')
    expect(ref1).toMatchObject({ first_name: 'Anna', last_name: 'M', country: 'CHE' })
    expect(ref1).not.toHaveProperty('firstName')
  })

  it('repairs an object-format value into an array', () => {
    const out = mergeOfficialsEdits({ ref1: { firstName: 'A', lastName: 'B' } }, { ref1: { firstName: 'A', lastName: 'C' } })
    expect(out).toEqual([{ role: '1st referee', firstName: 'A', lastName: 'C' }])
  })

  it('does not mutate the input', () => {
    const copy = JSON.parse(JSON.stringify(existing))
    mergeOfficialsEdits(existing, { ref1: { firstName: 'Q', lastName: 'R' } })
    expect(existing).toEqual(copy)
  })
})

describe('officialsFromSchedule', () => {
  it('a game with referees: their names, CHE and the DOB as DD.MM.YYYY', () => {
    expect(officialsFromSchedule({
      referee1First: 'Carla', referee1Last: 'Moser', referee1Dob: '1985-04-03',
      referee2First: 'Ben', referee2Last: 'Roth', linesman1: 'Lea Frei'
    })).toEqual({
      ref1: { first: 'Carla', last: 'Moser', country: 'CHE', dob: '03.04.1985' },
      ref2: { first: 'Ben', last: 'Roth', country: 'CHE', dob: '' },
      lineJudge1: 'Lea Frei',
      lineJudge2: ''
    })
  })

  it('a game without referees or line judges clears them all (none kept from an earlier game)', () => {
    const none = { first: '', last: '', country: 'CHE', dob: '' }
    expect(officialsFromSchedule({ home: 'A', away: 'B' })).toEqual({ ref1: none, ref2: none, lineJudge1: '', lineJudge2: '' })
  })
})
