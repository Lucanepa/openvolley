import { describe, it, expect } from 'vitest'
import { applyEinsatzlisteToGameDraft, clubPersonOf, gameRosterDraft, mergeImportedRoster, parsedPdfToRoster } from '../teamRosters'

// The saved team: numbers, a captain; Paolo is the coach, Anna the first assistant
const squad = {
  players: [
    { number: 7, first_name: 'Marco', last_name: 'Muster', dob: '2004-03-14', license_number: '123456', is_captain: true, is_libero: false },
    { number: 12, first_name: 'Luca', last_name: 'Beispiel', dob: null, license_number: null, is_captain: false, is_libero: true },
    { number: 3, first_name: 'Noah', last_name: 'Exemple', dob: null, license_number: null, is_captain: false, is_libero: false }
  ],
  staff: [
    { role: 'Coach', first_name: 'Paolo', last_name: 'Bianchi', dob: null, license_number: null },
    { role: 'Assistant Coach 1', first_name: 'Anna', last_name: 'Rossi', dob: null, license_number: null }
  ]
}
// The Einsatzliste: no shirt numbers; Anna coach, Paolo first assistant
const parsed = {
  players: [
    // a number the PDF's text seems to give is ignored
    { number: 99, licence: '123456', firstName: 'Marco', lastName: 'Muster', dob: '14/03/2004' },
    { number: null, licence: '234567', firstName: 'Luca', lastName: 'Beispiel', dob: '02/07/1999' },
    { number: null, licence: '345678', firstName: 'Mia', lastName: 'Neu', dob: '01/02/2005' }
  ],
  coach: { firstName: 'Anna', lastName: 'Rossi', dob: '', birthYear: '1985', licence: '10001' },
  ac1: { firstName: 'Paolo', lastName: 'Bianchi', dob: '', birthYear: '1988', licence: '10002' }
}

describe('an Einsatzliste on a game roster', () => {
  const imported = parsedPdfToRoster(parsed)
  const { draft } = applyEinsatzlisteToGameDraft(gameRosterDraft(squad, null), imported)

  it('keeps the saved numbers, captain and libero; ticks the listed players', () => {
    const by = Object.fromEntries(draft.players.map((p) => [p.last_name, p]))
    expect(by.Muster).toMatchObject({ number: 7, is_captain: true, picked: true })
    expect(by.Beispiel).toMatchObject({ number: 12, is_libero: true, picked: true, license_number: '234567', dob: '1999-07-02' })
    expect(by.Neu).toMatchObject({ number: '', is_captain: false, is_libero: false, picked: true, license_number: '345678' })
    expect(by.Exemple).toMatchObject({ number: 3, picked: false })
  })

  it('gives the officials the roles of the list, one entry per person', () => {
    const picked = draft.staff.filter((s) => s.picked).map((s) => [s.role, s.last_name, s.license_number])
    expect(picked).toEqual([['Coach', 'Rossi', '10001'], ['Assistant Coach 1', 'Bianchi', '10002']])
    expect(draft.staff).toHaveLength(2)
  })

  it('an official with the licence is found in the club', () => {
    const people = [{ sv_number: '10001', first_name: 'Anna', last_name: 'Rossi', dob: '1985-05-04' }]
    expect(clubPersonOf(draft.staff[0], people)).toBe(people[0])
  })
})

describe('an Einsatzliste on the saved team', () => {
  it('swaps the officials into the roles of the list, keeps the numbers', () => {
    const r = mergeImportedRoster(squad.players, squad.staff, parsedPdfToRoster(parsed))
    expect(r.players.find((p) => p.last_name === 'Muster').number).toBe(7)
    expect(r.staff.map((s) => [s.role, s.last_name])).toEqual([['Assistant Coach 1', 'Bianchi'], ['Coach', 'Rossi']])
  })

  it('whoever else held a role of the list leaves; the role is held once', () => {
    const staff = [
      { role: 'Coach', first_name: 'Old', last_name: 'Coach' },
      { role: 'Coach', first_name: 'Anna', last_name: 'Rossi' },
      { role: 'Physiotherapist', first_name: 'Sara', last_name: 'Verdi' }
    ]
    const r = mergeImportedRoster([], staff, { players: [], staff: [{ role: 'Coach', first_name: 'Anna', last_name: 'Rossi', dob: null, license_number: '10001' }] })
    expect(r.staff.map((s) => [s.role, s.last_name, s.license_number ?? null])).toEqual([['Coach', 'Rossi', '10001'], ['Physiotherapist', 'Verdi', null]])
  })
})
