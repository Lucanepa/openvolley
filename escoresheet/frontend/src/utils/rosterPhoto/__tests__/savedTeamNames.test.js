import { describe, it, expect } from 'vitest'
import { withSavedTeamNames } from '../savedTeamNames'
import { fieldIssues, importedRosterOf } from '../../../domain/importedRoster'

// Made-up people
const savedTeam = {
  players: [
    { number: 3, first_name: 'Piotr', last_name: 'Krawczyński', license_number: '123458', active: true },
    { number: 9, first_name: 'Sven', last_name: 'Müller-Lüdenscheidt', license_number: '123459', active: true }
  ],
  staff: [{ role: 'Coach', first_name: 'Hans', last_name: 'Muster', license_number: '10001' }]
}

describe('withSavedTeamNames: the saved team\'s spelling where the SV number matches', () => {
  it('a known SV number gets the saved names, sure; an unknown one stays as read', () => {
    const read = importedRosterOf({
      players: [
        { licence: '123458', firstName: 'Piotr', lastName: 'Krawczynski', confidence: { licence: 0.96, firstName: 0.43, lastName: 0.43 } },
        { licence: '123499', firstName: 'Lara', lastName: 'Schnüfier', confidence: { licence: 0.9, lastName: 0.4 } }
      ],
      coach: { firstName: 'Hans', lastName: 'Musler', licence: '10001', confidence: { lastName: 0.5 } }
    }, 'ocr')
    const r = withSavedTeamNames(read, savedTeam)
    expect(r.players[0]).toMatchObject({ firstName: 'Piotr', lastName: 'Krawczyński', fromSavedTeam: true, confidence: { firstName: 1, lastName: 1 } })
    expect(r.players[1]).toMatchObject({ lastName: 'Schnüfier' })
    expect(r.players[1].fromSavedTeam).toBeUndefined()
    expect(r.coach).toMatchObject({ lastName: 'Muster', fromSavedTeam: true })
    // nothing left to check on the matched rows
    expect(fieldIssues(r).players[0]).toEqual({})
  })

  it('an SV number not read, the name known: the saved SV number', () => {
    const read = importedRosterOf({ players: [{ licence: '', firstName: 'Sven', lastName: 'Muller-Ludenscheidt' }] }, 'ocr')
    expect(withSavedTeamNames(read, savedTeam).players[0]).toMatchObject({ licence: '123459', fromSavedTeam: true })
  })

  it('no saved team: as read', () => {
    const read = importedRosterOf({ players: [{ licence: '123458', firstName: 'P', lastName: 'K' }] }, 'ocr')
    expect(withSavedTeamNames(read, null)).toBe(read)
  })
})
