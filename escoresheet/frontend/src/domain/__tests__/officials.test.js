import { describe, it, expect } from 'vitest'
import { officialsToArray, mergeOfficialsEdits } from '../officials'

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
