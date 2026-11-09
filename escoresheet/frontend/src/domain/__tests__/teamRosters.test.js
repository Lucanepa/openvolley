import { describe, it, expect } from 'vitest'
import { gameRosterBody, gameRosterDraft, mergeImportedRoster, parsedPdfToRoster } from '../teamRosters'

const squad = {
  players: [
    { id: 'a', number: 4, first_name: 'Anna', last_name: 'Muster', dob: '2001-02-03', license_number: 'L4', is_captain: true, is_libero: false, active: true },
    { id: 'b', number: 7, first_name: 'Bea', last_name: 'Libero', dob: '2002-03-04', license_number: null, is_libero: true, active: true },
    { id: 'c', number: 9, first_name: 'Cara', last_name: 'Reserve', dob: null, active: false }
  ],
  staff: [{ id: 's', role: 'Coach', first_name: 'Chris', last_name: 'Coach', dob: '1980-01-01' }]
}

describe('parsedPdfToRoster', () => {
  it('turns the PDF reader\'s players and officials into the API shape (ISO dates)', () => {
    const r = parsedPdfToRoster({
      players: [{ number: 12, firstName: 'Lea', lastName: 'Keller', dob: '05/06/2003' }, { number: 'x', firstName: '', lastName: '' }],
      coach: { firstName: 'Max', lastName: 'Trainer', dob: '01/01/1975' },
      ac1: null,
      ac2: { firstName: 'Ida', lastName: 'Zwei', dob: '' }
    })
    expect(r.players).toEqual([{ number: 12, first_name: 'Lea', last_name: 'Keller', dob: '2003-06-05', license_number: null, is_libero: false, is_captain: false }])
    expect(r.staff.map(s => [s.role, s.last_name, s.dob])).toEqual([['Coach', 'Trainer', '1975-01-01'], ['Assistant Coach 2', 'Zwei', null]])
  })
})

describe('mergeImportedRoster', () => {
  it('updates players of the same name and adds the new ones; officials by role', () => {
    const imported = {
      players: [{ number: 5, first_name: 'anna', last_name: 'MUSTER', dob: '2001-02-03' }, { number: 9, first_name: 'Cara', last_name: 'Reserve', dob: '2004-04-04' }, { number: 11, first_name: 'Neu', last_name: 'Neue', dob: null }],
      staff: [{ role: 'Coach', first_name: 'Chris', last_name: 'Coach', dob: '1980-01-01' }, { role: 'Assistant Coach 1', first_name: 'A', last_name: 'Assist', dob: null }]
    }
    const r = mergeImportedRoster(squad.players, squad.staff, imported)
    expect(r.players.map(p => [p.last_name, p.number, p.active])).toEqual([['Muster', 5, true], ['Libero', 7, true], ['Reserve', 9, true], ['Neue', 11, true]])
    expect(r.players[0].id).toBe('a') // kept
    expect(r.players[2].dob).toBe('2004-04-04')
    expect(r.staff.map(s => s.role)).toEqual(['Coach', 'Assistant Coach 1'])
    expect(r.added).toBe(2)
    expect(r.updated).toBe(2)
  })
})

describe('gameRosterDraft and gameRosterBody', () => {
  it('a new roster ticks every active player when they fit, one person per role', () => {
    const d = gameRosterDraft(squad, null)
    expect(d.players.map(p => [p.last_name, p.picked])).toEqual([['Muster', true], ['Libero', true]])
    expect(d.staff.map(s => s.picked)).toEqual([true])
    const { body, problems } = gameRosterBody(d)
    expect(problems).toEqual([])
    expect(body.players).toEqual([
      { number: 4, first_name: 'Anna', last_name: 'Muster', dob: '2001-02-03', license_number: 'L4', is_libero: false, is_captain: true },
      { number: 7, first_name: 'Bea', last_name: 'Libero', dob: '2002-03-04', license_number: null, is_libero: true, is_captain: false }
    ])
    expect(body.staff).toEqual([{ role: 'Coach', first_name: 'Chris', last_name: 'Coach', dob: '1980-01-01', license_number: null }])
  })

  it('more than 14 active players: nobody is ticked yet', () => {
    const big = { players: Array.from({ length: 15 }, (_, i) => ({ number: i + 1, first_name: 'P', last_name: `L${i}`, active: true })), staff: [] }
    expect(gameRosterDraft(big, null).players.every(p => !p.picked)).toBe(true)
  })

  it('a roster sent before: its players ticked with its numbers, the others offered unticked', () => {
    const sent = { players: [{ number: 14, first_name: 'Bea', last_name: 'Libero', dob: '2002-03-04', is_libero: true, is_captain: true }, { number: 3, first_name: 'Gast', last_name: 'Gone', dob: null }], staff: [] }
    const d = gameRosterDraft(squad, sent)
    expect(d.players.map(p => [p.last_name, p.number, p.picked, p.is_captain])).toEqual([['Muster', 4, false, true], ['Libero', 14, true, true], ['Gone', 3, true, false]])
    expect(d.staff.map(s => s.picked)).toEqual([false])
  })

  it('names the problems the server would refuse', () => {
    const d = {
      players: [
        { key: '1', picked: true, number: '', first_name: 'No', last_name: 'Number' },
        { key: '2', picked: true, number: '5', first_name: 'A', last_name: 'A', is_captain: true, is_libero: true },
        { key: '3', picked: true, number: '5', first_name: 'B', last_name: 'B', is_captain: true, is_libero: true },
        { key: '4', picked: true, number: '6', first_name: 'C', last_name: 'C', is_libero: true },
        { key: '5', picked: false, number: '', first_name: 'Not', last_name: 'Picked' }
      ],
      staff: [{ key: 'a', picked: true, role: 'Coach', last_name: 'X' }, { key: 'b', picked: true, role: 'Coach', last_name: 'Y' }]
    }
    expect(gameRosterBody(d).problems.map(p => p.key)).toEqual([
      'manage.myTeams.problems.number',
      'manage.myTeams.problems.numberTwice',
      'manage.myTeams.problems.captains',
      'manage.myTeams.problems.liberos',
      'manage.myTeams.problems.roleTwice'
    ])
  })
})
