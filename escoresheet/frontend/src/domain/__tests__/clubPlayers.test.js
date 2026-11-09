// "Add from club" and the gender rule (db/024, docs/club-licences-spec.md):
// the manager's squad and game roster helpers (domain/teamRosters.js) and
// Match Setup's (domain/clubPlayers.js), for the players (the players list,
// the team's gender) and the team officials (anyone of the club, either
// gender). Made-up people only.
import { describe, it, expect } from 'vitest'
import { addClubPlayersToGameDraft, addClubPlayersToSquad, clubPersonToOfficial, clubPersonToPlayer, clubPlayersForGender, gameRosterBody, gameRosterDraft, mergeImportedRoster, officialIsPerson, officialOfRole, officialRolesOf, playerFinder, setGameDraftOfficial, setSquadOfficial, wrongGenderIndexes } from '../teamRosters'
import { addClubPlayersToRoster, benchOfficialOfRole, benchRolesOf, clubGenderWarnings, matchGenderOf, offeredClubPlayers, rosterHasPerson, setBenchOfficial } from '../clubPlayers'

const ANNA = { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f' }
const LEA = { sv_number: '100002', last_name: 'Muster', first_name: 'Léa', dob: '2006-01-31', gender: 'f' }
const MARCO = { sv_number: '100003', last_name: 'Probe', first_name: 'Marco', dob: '2001-11-02', gender: 'm' }
const KIM = { sv_number: '100004', last_name: 'Ohnegeschlecht', first_name: 'Kim', dob: null, gender: null }
const TINA = { sv_number: '200001', last_name: 'Trainer', first_name: 'Tina', dob: '1980-03-04', gender: 'f', lists: ['coaches'] }
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

describe('team officials from the club (manager)', () => {
  it('a club person is an official of the role, with licence and date of birth; matched by licence, else by name', () => {
    expect(clubPersonToOfficial(TINA, 'Coach')).toEqual({ role: 'Coach', first_name: 'Tina', last_name: 'Trainer', dob: '1980-03-04', license_number: '200001' })
    expect(officialIsPerson({ first_name: 'tina', last_name: 'TRAINER' }, TINA)).toBe(true)
    expect(officialIsPerson({ first_name: 'Trainer', last_name: 'Tina' }, TINA)).toBe(true)
    expect(officialIsPerson({ first_name: 'Someone', last_name: 'Else', license_number: '200001' }, TINA)).toBe(true)
    // the same name with another licence number is someone else
    expect(officialIsPerson({ first_name: 'Tina', last_name: 'Trainer', license_number: '999999' }, TINA)).toBe(false)
  })

  it('the squad: the role\'s row takes the person (keeps key and id), else a row is added; each role once', () => {
    const staff = [
      { key: 'a', id: 's1', role: 'Coach', first_name: 'Marco', last_name: 'Probe', dob: '2001-11-02', license_number: '' },
      { key: 'b', role: 'Medic', first_name: '', last_name: '', dob: '', license_number: '' }
    ]
    expect(officialRolesOf(staff, MARCO)).toEqual(['Coach'])
    expect(officialOfRole(staff, 'Medic')).toBeNull()
    let seq = 0
    const make = (s) => ({ key: `n${++seq}`, ...s, dob: s.dob || '', license_number: s.license_number || '' })
    // a woman as the coach of any team: no gender rule for officials
    const coach = setSquadOfficial(staff, 'Coach', ANNA, make)
    expect(coach.replaced).toMatchObject({ first_name: 'Marco' })
    expect(coach.staff).toHaveLength(2)
    expect(coach.staff[0]).toEqual({ key: 'a', id: 's1', role: 'Coach', first_name: 'Anna', last_name: 'Beispiel', dob: '2004-05-06', license_number: '100001' })
    // the empty medic row takes Kim (no date of birth in the list)
    const medic = setSquadOfficial(coach.staff, 'Medic', KIM, make)
    expect(medic.replaced).toBeNull()
    expect(medic.staff[1]).toEqual({ key: 'b', role: 'Medic', first_name: 'Kim', last_name: 'Ohnegeschlecht', dob: '', license_number: '100004' })
    // a role without a row: added
    const ac = setSquadOfficial(medic.staff, 'Assistant Coach 1', TINA, make)
    expect(ac.staff).toHaveLength(3)
    expect(ac.staff[2]).toEqual({ key: 'n1', role: 'Assistant Coach 1', first_name: 'Tina', last_name: 'Trainer', dob: '1980-03-04', license_number: '200001' })
    // the same person again keeps what the row has and the list does not
    const again = setSquadOfficial([{ key: 'c', role: 'Coach', first_name: 'Kim', last_name: 'Ohnegeschlecht', dob: '2000-01-01', license_number: '' }], 'Coach', KIM, make)
    expect(again.replaced).toBeNull()
    expect(again.staff[0]).toMatchObject({ dob: '2000-01-01', license_number: '100004' })
  })

  it('a game roster: the person ticked in the role, the one before unticked; the body has each role once', () => {
    const draft = gameRosterDraft({
      players: [{ number: 1, first_name: 'Marco', last_name: 'Probe' }],
      staff: [{ role: 'Coach', first_name: 'Marco', last_name: 'Probe', dob: null, license_number: null }, { role: 'Coach', first_name: 'Tina', last_name: 'Trainer' }]
    }, null)
    expect(draft.staff.map((s) => s.picked)).toEqual([true, false])
    expect(officialRolesOf(draft.staff, MARCO, { pickedOnly: true })).toEqual(['Coach'])
    expect(officialRolesOf(draft.staff, TINA, { pickedOnly: true })).toEqual([])
    // Tina is offered (not ticked): she is ticked, Marco unticked
    const r = setGameDraftOfficial(draft, 'Coach', TINA)
    expect(r.replaced).toMatchObject({ first_name: 'Marco' })
    expect(r.draft.staff.map((s) => [s.first_name, s.picked, s.license_number])).toEqual([['Marco', false, null], ['Tina', true, '200001']])
    // Anna is not offered: added, ticked, as assistant coach
    const r2 = setGameDraftOfficial(r.draft, 'Assistant Coach 1', ANNA)
    expect(r2.replaced).toBeNull()
    expect(r2.draft.staff).toHaveLength(3)
    expect(r2.draft.staff[2]).toMatchObject({ key: 'Assistant Coach 1|beispiel|anna', role: 'Assistant Coach 1', first_name: 'Anna', license_number: '100001', dob: '2004-05-06', picked: true })
    const { body, problems } = gameRosterBody(r2.draft)
    expect(problems).toEqual([])
    expect(body.staff).toEqual([
      { role: 'Coach', first_name: 'Tina', last_name: 'Trainer', dob: '1980-03-04', license_number: '200001' },
      { role: 'Assistant Coach 1', first_name: 'Anna', last_name: 'Beispiel', dob: '2004-05-06', license_number: '100001' }
    ])
    // no gender rule for officials (players only)
    expect(wrongGenderIndexes(body.players, CLUB, 'm')).toEqual([])
  })
})

describe('bench officials from the club (Match Setup)', () => {
  const bench = [
    { role: 'Coach', firstName: 'Marco', lastName: 'Probe', dob: '02.11.2001' },
    { role: 'Assistant Coach 1', firstName: '', lastName: '', dob: '' }
  ]

  it('finds who holds which role by name, also with the names swapped', () => {
    expect(benchRolesOf(bench, MARCO)).toEqual(['Coach'])
    expect(benchRolesOf([{ role: 'Medic', firstName: 'Probe', lastName: 'Marco' }], MARCO)).toEqual(['Medic'])
    expect(benchRolesOf(bench, ANNA)).toEqual([])
    expect(benchOfficialOfRole(bench, 'Coach')).toMatchObject({ firstName: 'Marco' })
    expect(benchOfficialOfRole(bench, 'Assistant Coach 1')).toBeNull()
  })

  it('the role\'s row takes the person (DD.MM.YYYY), else a row of that role is added; either gender', () => {
    const coach = setBenchOfficial(bench, 'Coach', TINA)
    expect(coach.replaced).toMatchObject({ firstName: 'Marco' })
    expect(coach.bench).toEqual([
      { role: 'Coach', firstName: 'Tina', lastName: 'Trainer', dob: '04.03.1980' },
      bench[1]
    ])
    const ac = setBenchOfficial(coach.bench, 'Assistant Coach 1', KIM)
    expect(ac.replaced).toBeNull()
    expect(ac.bench[1]).toEqual({ role: 'Assistant Coach 1', firstName: 'Kim', lastName: 'Ohnegeschlecht', dob: '' })
    const medic = setBenchOfficial(ac.bench, 'Medic', ANNA)
    expect(medic.bench).toHaveLength(3)
    expect(medic.bench[2]).toEqual({ role: 'Medic', firstName: 'Anna', lastName: 'Beispiel', dob: '06.05.2004' })
    // the same person again keeps the date of birth the list does not have
    expect(setBenchOfficial([{ role: 'Coach', firstName: 'Kim', lastName: 'Ohnegeschlecht', dob: '01.01.2000' }], 'Coach', KIM).bench[0].dob).toBe('01.01.2000')
  })

  it('the players picker keeps the gender filter, the warning stays for players', () => {
    expect(offeredClubPlayers(CLUB, 'm').players).toEqual([MARCO, KIM])
    expect(clubGenderWarnings([{ firstName: 'Anna', lastName: 'Beispiel', dob: '06.05.2004' }], CLUB, 'm')).toHaveLength(1)
  })
})
