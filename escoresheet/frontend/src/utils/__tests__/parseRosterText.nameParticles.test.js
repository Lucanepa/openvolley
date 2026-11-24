import { describe, it, expect } from 'vitest'
import { moveNameParticles, parseRosterText } from '../parseRosterPdf'

// Owner 09.11.2026: "Noel von Wattenwyl" was imported as first name "Noel von". Made-up names.
describe('moveNameParticles', () => {
  it('moves lowercase particles at the end of the first name to the last name', () => {
    expect(moveNameParticles('Noel von', 'Muster')).toEqual({ firstName: 'Noel', lastName: 'von Muster' })
    expect(moveNameParticles('Anna Maria van der', 'Berg')).toEqual({ firstName: 'Anna Maria', lastName: 'van der Berg' })
    expect(moveNameParticles('Luca de', 'Beispiel')).toEqual({ firstName: 'Luca', lastName: 'de Beispiel' })
  })
  it('leaves everything else alone', () => {
    expect(moveNameParticles('Jan', 'Cerny')).toEqual({ firstName: 'Jan', lastName: 'Cerny' })
    expect(moveNameParticles('Anna Maria', 'Muster')).toEqual({ firstName: 'Anna Maria', lastName: 'Muster' })
    expect(moveNameParticles('Von', 'Muster')).toEqual({ firstName: 'Von', lastName: 'Muster' }) // a first name, not a particle
    expect(moveNameParticles('von', 'Muster')).toEqual({ firstName: 'von', lastName: 'Muster' }) // never an empty first name
  })
})

describe('parseRosterText: particles in an Einsatzliste row', () => {
  it('reads "von Muster" as the last name', () => {
    const text = 'Einsatzliste 123456   Noel   von Muster   M   29.09.2002 234567   Jan   Beispiel   M   16.06.2004'
    const players = parseRosterText(text).players
    expect(players.map(p => [p.firstName, p.lastName, p.licence])).toEqual([
      ['Noel', 'von Muster', '123456'], ['Jan', 'Beispiel', '234567']
    ])
  })
})
