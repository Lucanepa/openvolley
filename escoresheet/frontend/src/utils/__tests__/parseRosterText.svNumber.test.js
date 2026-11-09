import { describe, it, expect } from 'vitest'
import { parseRosterText } from '../parseRosterPdf'

// VolleyManager's Einsatzliste: one row per player, the SV number (the Swiss
// Volley licence) first, no shirt numbers. Made-up rows.
describe('parseRosterText: the SV number of an Einsatzliste row', () => {
  it('is kept as the licence; the shirt number stays empty', () => {
    const text = [
      'Einsatzliste VBC Musterdorf H1',
      '123456   Marco   Muster   M   14.03.2004',
      '234567   Luca   Beispiel   M   02.07.1999',
      '98765   Noah   Exemple   M   23.11.2001'
    ].join(' ')
    const players = parseRosterText(text).players
    expect(players.map(p => [p.firstName, p.lastName, p.licence, p.number, p.dob])).toEqual([
      ['Marco', 'Muster', '123456', null, '14/03/2004'],
      ['Luca', 'Beispiel', '234567', null, '02/07/1999'],
      ['Noah', 'Exemple', '98765', null, '23/11/2001']
    ])
  })
})
