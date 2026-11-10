import { describe, it, expect } from 'vitest'
import { officialRoleOf, parseRosterText } from '../parseRosterPdf'

// VolleyManager's Einsatzliste in each of its languages: the players' rows
// (SV number first, no shirt numbers) and the officials "<role>: #<SV> |
// <first> <last> (<year>)". Made-up people.
const rows = '123456 Marco Muster M 14.03.2004 234567 Luca Beispiel M 02.07.1999'
const lists = {
  it: `Lista di formazione ${rows} Allenatore: #52205 | Anna Rossi (1997) 1. Assistente allenatore: #90382 | Paolo Bianchi (1993) Fisioterapista: #11223 | Sara Verdi (1990)`,
  de: `Einsatzliste ${rows} Trainer: #52205 | Anna Rossi (1997) 1. Assistenztrainer: #90382 | Paolo Bianchi (1993) Physiotherapeutin: #11223 | Sara Verdi (1990)`,
  fr: `Liste d'engagement ${rows} Entraîneur: #52205 | Anna Rossi (1997) 1er entraîneur adjoint: #90382 | Paolo Bianchi (1993) Physiothérapeute: #11223 | Sara Verdi (1990)`,
  en: `Line-up ${rows} Coach: #52205 | Anna Rossi (1997) 1. Assistant Coach: #90382 | Paolo Bianchi (1993) Physiotherapist: #11223 | Sara Verdi (1990)`
}

describe('parseRosterText: the officials of an Einsatzliste, in any language', () => {
  for (const [lang, text] of Object.entries(lists)) {
    it(`${lang}: roles, licences, no made-up date of birth`, () => {
      const r = parseRosterText(text)
      expect(r.players.map((p) => [p.firstName, p.lastName, p.licence, p.number])).toEqual([
        ['Marco', 'Muster', '123456', null],
        ['Luca', 'Beispiel', '234567', null]
      ])
      expect(r.coach).toEqual({ firstName: 'Anna', lastName: 'Rossi', dob: '', birthYear: '1997', licence: '52205' })
      expect(r.ac1).toMatchObject({ firstName: 'Paolo', lastName: 'Bianchi', licence: '90382' })
      expect(r.ac2).toBeNull()
      expect(r.physio).toMatchObject({ firstName: 'Sara', lastName: 'Verdi', licence: '11223' })
    })
  }

  it('the second assistant and the medic', () => {
    const r = parseRosterText(`${rows} Coach: #1111 | Anna Rossi (1997) 2. Assistant Coach: #2222 | Paolo Bianchi (1993) Teamarzt: #3333 | Sara Verdi (1980)`)
    expect(r.ac1).toBeNull()
    expect(r.ac2).toMatchObject({ lastName: 'Bianchi', licence: '2222' })
    expect(r.medic).toMatchObject({ lastName: 'Verdi', licence: '3333' })
  })

  it('role words in any language', () => {
    expect(officialRoleOf('Allenatore')).toBe('coach')
    expect(officialRoleOf('Head coach')).toBe('coach')
    expect(officialRoleOf('2. Assistente allenatore')).toBe('ac2')
    expect(officialRoleOf('2e entraîneur adjoint')).toBe('ac2')
    expect(officialRoleOf('Co-Trainer')).toBe('ac')
    expect(officialRoleOf('Medico')).toBe('medic')
    expect(officialRoleOf('Médecin')).toBe('medic')
    expect(officialRoleOf('Fisioterapista')).toBe('physio')
    expect(officialRoleOf('Spielplan')).toBeNull()
  })
})
