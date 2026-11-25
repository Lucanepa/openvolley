import { describe, it, expect, beforeEach } from 'vitest'
import { displayOrder, readRosterSort, saveRosterSort, ROSTER_SORT_KEY } from '../rosterOrder'

const roster = [
  { number: 1, lastName: 'Keller', firstName: 'Luca' },
  { number: 2, lastName: 'Hofmann', firstName: 'Jonas' },
  { number: 7, lastName: 'Müller', firstName: 'Ben' },
  { number: 9, lastName: 'mueller', firstName: 'Anna' },
  { number: 3, lastName: 'Keller', firstName: 'Anna' },
  { number: '', lastName: '', firstName: '' }
]

describe('displayOrder', () => {
  it('by number: the roster as it is kept (indices unchanged)', () => {
    expect(displayOrder(roster, 'number')).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('A–Z: last name, then first name, accents and case ignored; a row without a name last', () => {
    expect(displayOrder(roster, 'name').map(i => `${roster[i].lastName} ${roster[i].firstName}`.trim())).toEqual([
      'Hofmann Jonas', 'Keller Anna', 'Keller Luca', 'mueller Anna', 'Müller Ben', ''
    ])
  })

  it('never changes the roster itself', () => {
    const copy = JSON.stringify(roster)
    displayOrder(roster, 'name')
    expect(JSON.stringify(roster)).toBe(copy)
  })
})

describe('the choice on this device', () => {
  beforeEach(() => localStorage.removeItem(ROSTER_SORT_KEY))
  it('defaults to number; A–Z is remembered', () => {
    expect(readRosterSort()).toBe('number')
    saveRosterSort('name')
    expect(readRosterSort()).toBe('name')
    saveRosterSort('number')
    expect(readRosterSort()).toBe('number')
  })
})
