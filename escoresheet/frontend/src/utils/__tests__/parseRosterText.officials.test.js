import { describe, it, expect } from 'vitest'
import { officialRoleOf, parseRosterText } from '../parseRosterPdf'

// VolleyManager's Einsatzliste in each of its languages (German, French, Italian): the players' rows
// (SV number first, no shirt numbers) and the officials "<role>: #<SV> |
// <first> <last> (<year>)". Made-up people.
const rows = '123456 Marco Muster M 14.03.2004 234567 Luca Beispiel M 02.07.1999'
const lists = {
  it: `Lista di formazione ${rows} Allenatore: #10001 | Anna Rossi (1985) 1. Assistente allenatore: #10002 | Paolo Bianchi (1988)`,
  de: `Einsatzliste ${rows} Trainer: #10001 | Anna Rossi (1985) 1. Assistenztrainer: #10002 | Paolo Bianchi (1988)`,
  fr: `Liste d'engagement ${rows} Entraîneur: #10001 | Anna Rossi (1985) 1er entraîneur adjoint: #10002 | Paolo Bianchi (1988)`,
}

describe('parseRosterText: the officials of an Einsatzliste, in any language', () => {
  for (const [lang, text] of Object.entries(lists)) {
    it(`${lang}: roles, licences, no made-up date of birth`, () => {
      const r = parseRosterText(text)
      expect(r.players.map((p) => [p.firstName, p.lastName, p.licence, p.number])).toEqual([
        ['Marco', 'Muster', '123456', null],
        ['Luca', 'Beispiel', '234567', null]
      ])
      expect(r.coach).toEqual({ firstName: 'Anna', lastName: 'Rossi', dob: '', birthYear: '1985', licence: '10001' })
      expect(r.ac1).toMatchObject({ firstName: 'Paolo', lastName: 'Bianchi', licence: '10002' })
      expect(r.ac2).toBeNull()
      expect(r.physio).toBeUndefined()
    })
  }

  it('the second assistant; anything else is no official of the list', () => {
    const r = parseRosterText(`${rows} Trainer: #1111 | Anna Rossi (1985) 2. Assistenztrainer: #2222 | Paolo Bianchi (1988) Teamarzt: #3333 | Sara Verdi (1980)`)
    expect(r.ac1).toBeNull()
    expect(r.ac2).toMatchObject({ lastName: 'Bianchi', licence: '2222' })
    expect(r.medic).toBeUndefined()
  })

  it('names with Central European letters are read (ń, ř, ș)', () => {
    const r = parseRosterText('Trainer: #1111 | Anna Rossi (1985) 323239 Ewa Wiśniewskiń M 16.09.1999 RLL 456789 Jiří Dvořák M 01.02.2000 RLL 567890 Ștefan Popescu M 03.04.2001 RLL')
    expect(r.players.map((p) => [p.firstName, p.lastName, p.licence])).toEqual([
      ['Ewa', 'Wiśniewskiń', '323239'], ['Jiří', 'Dvořák', '456789'], ['Ștefan', 'Popescu', '567890']
    ])
  })

  it('role words in any language', () => {
    expect(officialRoleOf('Allenatore')).toBe('coach')
    expect(officialRoleOf('Head coach')).toBe('coach')
    expect(officialRoleOf('2. Assistente allenatore')).toBe('ac2')
    expect(officialRoleOf('2e entraîneur adjoint')).toBe('ac2')
    expect(officialRoleOf('Co-Trainer')).toBe('ac')
    expect(officialRoleOf('Medico')).toBeNull()
    expect(officialRoleOf('Physiothérapeute')).toBeNull()
    expect(officialRoleOf('Spielplan')).toBeNull()
  })
})
