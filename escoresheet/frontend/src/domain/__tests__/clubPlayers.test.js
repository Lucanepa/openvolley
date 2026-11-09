// "Add from club" and the gender rule (db/024, docs/club-licences-spec.md):
// the manager's squad and game roster helpers (domain/teamRosters.js) and
// Match Setup's (domain/clubPlayers.js). Made-up people only.
import { describe, it, expect } from 'vitest'
import { addClubPlayersToGameDraft, addClubPlayersToSquad, clubPersonToPlayer, clubPlayersForGender, gameRosterDraft, mergeImportedRoster, playerFinder, wrongGenderIndexes } from '../teamRosters'
import { addClubPlayersToRoster, clubGenderWarnings, matchGenderOf, offeredClubPlayers, rosterHasPerson } from '../clubPlayers'

const ANNA = { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f' }
const LEA = { sv_number: '100002', last_name: 'Muster', first_name: 'Léa', dob: '2006-01-31', gender: 'f' }
const MARCO = { sv_number: '100003', last_name: 'Probe', first_name: 'Marco', dob: '2001-11-02', gender: 'm' }
const KIM = { sv_number: '100004', last_name: 'Ohnegeschlecht', first_name: 'Kim', dob: null, gender: null }
const CLUB = [ANNA, LEA, MARCO, KIM]

describe('the club\'s players for a team (manager)', () => {
  it('a club person is a player without a number', () => {
    expect(clubPersonToPlayer(ANNA)).toEqual({ number: null, first_name: 'Anna', last_name: 'Beispiel', dob: '2004-05-06', license_number: '100001', is_libero: false, is_captain: false })
  })

  it('offers the team\'s gender and those without one; everyone while the team\'s gender is unknown', () => {
    expect(clubPlayersForGender(CLUB, 'f').map((p) => p.last_name)).toEqual(['Beispiel', 'Muster', 'Ohnegeschlecht'])
    expect(clubPlayersForGender(CLUB, 'm').map((p) => p.last_name)).toEqual(['Probe', 'Ohnegeschlecht'])
    expect(clubPlayersForGender(CLUB, null)).toHaveLength(4)
  })

  it('finds a player of the other gender by licence number, as the server does', () => {
    const players = [clubPersonToPlayer(MARCO), clubPersonToPlayer(ANNA), { first_name: 'Ohne', last_name: 'Lizenz', license_number: null }, clubPersonToPlayer(KIM)]
    expect(wrongGenderIndexes(players, CLUB, 'm')).toEqual([1])
    expect(wrongGenderIndexes(players, CLUB, 'f')).toEqual([0])
    expect(wrongGenderIndexes(players, CLUB, null)).toEqual([])
    // the same name with another licence number is someone else
    expect(wrongGenderIndexes([{ ...clubPersonToPlayer(ANNA), license_number: '999999' }], CLUB, 'm')).toEqual([])
  })

  it('the squad: nobody twice (the same licence, else the same name), new ones without a number', () => {
    const squad = [
      { key: 'a', number: 4, first_name: 'Anna', last_name: 'Beispiel', dob: '', license_number: '', active: true },
      { key: 'b', number: 7, first_name: 'Lea', last_name: 'Muster', dob: '2006-01-31', license_number: '100002', active: false }
    ]
    let seq = 0
    const make = (p) => ({ key: `n${++seq}`, ...p, number: p.number ?? '' })
    const r = addClubPlayersToSquad(squad, [], [ANNA, LEA, MARCO], make)
    expect(r.added).toBe(1)
    expect(r.players).toHaveLength(3)
    // Anna by name: she gets the licence and the date of birth, keeps her number
    expect(r.players[0]).toMatchObject({ key: 'a', number: 4, license_number: '100001', dob: '2004-05-06' })
    // Lea by licence (her name has an accent in the list): active again
    expect(r.players[1]).toMatchObject({ key: 'b', number: 7, active: true })
    expect(r.players[2]).toMatchObject({ key: 'n1', number: '', first_name: 'Marco', last_name: 'Probe', license_number: '100003', active: true })
    // twice in a row: nothing more
    expect(addClubPlayersToSquad(r.players, [], [ANNA, MARCO], make).added).toBe(0)
  })

  it('a game roster: one offered is ticked, the others added ticked; mergeImportedRoster keeps its rules', () => {
    const draft = gameRosterDraft({ players: [{ number: 4, first_name: 'Marco', last_name: 'Probe', dob: null, license_number: null }, { number: 9, first_name: 'Kim', last_name: 'Ohnegeschlecht' }] }, { players: [{ number: 9, first_name: 'Kim', last_name: 'Ohnegeschlecht' }] })
    expect(draft.players.map((p) => p.picked)).toEqual([false, true])
    const r = addClubPlayersToGameDraft(draft, [MARCO, KIM, LEA])
    expect([r.added, r.ticked]).toEqual([1, 1])
    expect(r.draft.players.map((p) => [p.last_name, p.picked, p.number, p.license_number])).toEqual([
      ['Probe', true, 4, '100003'], ['Ohnegeschlecht', true, 9, '100004'], ['Muster', true, '', '100002']
    ])
    expect(new Set(r.draft.players.map((p) => p.key)).size).toBe(3)
    const finder = playerFinder(r.draft.players)
    expect(finder.find(clubPersonToPlayer(LEA))).toBe(2)
    expect(finder.find({ first_name: 'Probe', last_name: 'Marco' })).toBe(0)
    expect(mergeImportedRoster([], [], { players: [clubPersonToPlayer(ANNA), clubPersonToPlayer(ANNA)] }).added).toBe(1)
  })
})

describe('the club\'s players in Match Setup', () => {
  it('the game\'s gender: the schedule\'s, none for a test match', () => {
    expect(matchGenderOf({ type2: 'men' })).toBe('m')
    expect(matchGenderOf({ type2: 'women' })).toBe('f')
    expect(matchGenderOf({ test: true, type2: 'women' })).toBeNull()
    expect(matchGenderOf({})).toBeNull()
    expect(offeredClubPlayers(CLUB, 'm')).toEqual({ players: [MARCO, KIM], hidden: 2 })
    expect(offeredClubPlayers(CLUB, null).hidden).toBe(0)
  })

  it('adds the chosen ones without a number, nobody twice', () => {
    const roster = [{ number: 4, firstName: 'Marco', lastName: 'Probe', dob: '02.11.2001', libero: '', isCaptain: true, isLfp: false }]
    expect(rosterHasPerson(roster, MARCO)).toBe(true)
    expect(rosterHasPerson(roster, { first_name: 'Probe', last_name: 'Marco' })).toBe(true)
    const r = addClubPlayersToRoster(roster, [MARCO, KIM])
    expect(r.added).toBe(1)
    expect(r.roster).toEqual([roster[0], { number: null, firstName: 'Kim', lastName: 'Ohnegeschlecht', dob: '', libero: '', isCaptain: false, isLfp: false }])
  })

  it('warns about a roster player the club has with the other gender (by name and date of birth), never for a test match', () => {
    const roster = [
      { number: 1, firstName: 'Marco', lastName: 'Probe', dob: '02.11.2001' },
      { number: 2, firstName: 'Anna', lastName: 'Beispiel', dob: '06.05.2004' },
      { number: 3, firstName: 'Lea', lastName: 'Muster', dob: '' },
      { number: 4, firstName: 'Anna', lastName: 'Beispiel', dob: '01.01.1999' }
    ]
    expect(clubGenderWarnings(roster, CLUB, 'm')).toEqual([
      { index: 1, name: 'Anna Beispiel', gender: 'f' },
      { index: 2, name: 'Lea Muster', gender: 'f' }
    ])
    expect(clubGenderWarnings(roster, CLUB, 'f')).toEqual([{ index: 0, name: 'Marco Probe', gender: 'm' }])
    expect(clubGenderWarnings(roster, CLUB, null)).toEqual([])
    // the same name twice in the list with both genders and no date to tell them apart: nothing
    const twins = [{ ...MARCO, sv_number: '1', dob: null }, { ...MARCO, sv_number: '2', dob: null, gender: 'f' }]
    expect(clubGenderWarnings([{ firstName: 'Marco', lastName: 'Probe', dob: '' }], twins, 'm')).toEqual([])
  })
})
