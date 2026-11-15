// Dates of birth on 1 January (01.01.1900, the placeholder of an unknown
// date, or a bad import): the roster editor notes them, the coin toss does
// not (owner 2026-11-15). Made-up names.
import { describe, it, expect } from 'vitest'
import { isJanuaryFirstDob, januaryFirstDobs } from '../januaryFirstDob'

describe('isJanuaryFirstDob', () => {
  it.each(['01.01.1900', '01/01/1900', '1.1.2004', '01.01.2004', '1900-01-01', ' 01.01.1999 '])('%s is 1 January', (dob) => {
    expect(isJanuaryFirstDob(dob)).toBe(true)
  })
  it.each(['', null, undefined, '11.01.2004', '01.10.2004', '10.01.2001', '2004-01-10', '2004-10-01', '01.01.'])('%s is not', (dob) => {
    expect(isJanuaryFirstDob(dob)).toBe(false)
  })
})

describe('januaryFirstDobs', () => {
  it('lists the players and the bench officials born on 1 January, in roster order', () => {
    const roster = [
      { number: 4, lastName: 'Muster', firstName: 'Anna', dob: '01.01.1900' },
      { number: 7, lastName: 'Beispiel', firstName: 'Bea', dob: '14.03.2005' },
      { number: 9, lastName: '', firstName: '', dob: '01.01.2006' }
    ]
    const bench = [{ role: 'Coach', lastName: 'Trainer', firstName: 'Tom', dob: '1975-01-01' }, { role: 'Physio', dob: '01.01.1980' }]
    expect(januaryFirstDobs(roster, bench)).toEqual([
      { name: 'Muster Anna', dob: '01.01.1900' },
      { name: '#9', dob: '01.01.2006' },
      { name: 'Trainer Tom', dob: '1975-01-01' },
      { name: 'Physio', dob: '01.01.1980' }
    ])
  })
  it('none without such dates or without people', () => {
    expect(januaryFirstDobs([{ number: 1, dob: '02.01.2000' }], [{ role: 'Coach', dob: '' }])).toEqual([])
    expect(januaryFirstDobs()).toEqual([])
    expect(januaryFirstDobs(null, null)).toEqual([])
  })
})
