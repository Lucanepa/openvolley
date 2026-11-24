import { describe, it, expect } from 'vitest'
import { sortPlayersByNumber, draftToRosterBody } from '../manage/TeamEditor'

// Save keeps the squad in shirt-number order (owner 09.11.2026): the server
// stores the body's order as sort_order, so scorers load it the same way.
describe('sortPlayersByNumber', () => {
  it('orders by number; no number last, in the order they had', () => {
    const rows = [
      { key: 'a', number: '28' }, { key: 'b', number: '' }, { key: 'c', number: '4' },
      { key: 'd', number: 10 }, { key: 'e', number: null }, { key: 'f', number: '7' }
    ]
    expect(sortPlayersByNumber(rows).map(r => r.key)).toEqual(['c', 'f', 'd', 'a', 'b', 'e'])
  })

  it('the body sent on Save follows that order', () => {
    const body = draftToRosterBody(sortPlayersByNumber([
      { number: '12', first_name: 'B', last_name: 'Zwei', dob: '', license_number: '', is_libero: false, is_captain: false, active: true },
      { number: '3', first_name: 'A', last_name: 'Eins', dob: '', license_number: '123456', is_libero: false, is_captain: false, active: true }
    ]), [])
    expect(body.players.map(p => [p.number, p.license_number])).toEqual([[3, '123456'], [12, null]])
  })
})
