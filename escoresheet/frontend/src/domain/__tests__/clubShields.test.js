import { describe, it, expect } from 'vitest'
import { clubFillOf, clubPersonOf, handTypedForClub, linkRowToClubPerson } from '../teamRosters'

// Green and gray shields (owner 2026-11-10): who of a roster is in the club's
// lists, and who typed by hand Save offers to keep there. Made-up people.
// No dates of birth since db/048: the licence number, else the name when
// exactly one person of the club has it.

const ANNA = { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', gender: 'f', lists: ['players'] }
const MARCO = { sv_number: '100003', last_name: 'Probe', first_name: 'Marco', gender: 'm', lists: ['players', 'coaches'] }
const ZOE = { sv_number: '100005', last_name: 'Müller', first_name: 'Zoé', gender: 'f', lists: ['coaches'] }
const PEOPLE = [ANNA, MARCO, ZOE]

describe('clubPersonOf', () => {
  it('the same licence number is the club person, whatever the names say', () => {
    expect(clubPersonOf({ first_name: 'M.', last_name: 'P', license_number: ' 100003 ' }, PEOPLE)).toBe(MARCO)
  })
  it('without a licence: the same name (accents, case, order aside) when exactly one person of the club has it', () => {
    expect(clubPersonOf({ first_name: 'zoe', last_name: 'MULLER', license_number: '' }, PEOPLE)).toBe(ZOE)
    expect(clubPersonOf({ first_name: 'Probe', last_name: 'Marco', license_number: null }, PEOPLE)).toBe(MARCO)
    // an older draft's date of birth plays no part
    expect(clubPersonOf({ first_name: 'Anna', last_name: 'Beispiel', dob: '1990-01-01' }, PEOPLE)).toBe(ANNA)
  })
  it('a licence number the club does not have is nobody of the club, whatever the name says', () => {
    expect(clubPersonOf({ first_name: 'Anna', last_name: 'Beispiel', license_number: '999999' }, PEOPLE)).toBeNull()
  })
  it('two people of the club with that name (uploaded or kept by hand), no last name or no lists: typed by hand (null)', () => {
    const twin = { ...ANNA, sv_number: '100009' }
    expect(clubPersonOf({ first_name: 'Anna', last_name: 'Beispiel' }, [ANNA, twin])).toBeNull()
    const kept = { ...ANNA, sv_number: '400002', manual: true }
    expect(clubPersonOf({ first_name: 'Anna', last_name: 'Beispiel' }, [kept, ANNA])).toBeNull()
    expect(clubPersonOf({ first_name: 'Anna', last_name: '' }, PEOPLE)).toBeNull()
    expect(clubPersonOf({ first_name: 'Ana', last_name: 'Beispiel' }, PEOPLE)).toBeNull()
    expect(clubPersonOf({ first_name: 'Anna', last_name: 'Beispiel', license_number: '100001' }, [])).toBeNull()
    expect(clubPersonOf(null, PEOPLE)).toBeNull()
    // the licence still finds one of two namesakes
    expect(clubPersonOf({ first_name: 'Anna', last_name: 'Beispiel', license_number: '100009' }, [ANNA, twin])).toBe(twin)
  })
})

describe('clubFillOf and linkRowToClubPerson', () => {
  it('fills only what the row leaves empty', () => {
    expect(clubFillOf({ first_name: '', last_name: 'Probe', license_number: '' }, MARCO)).toEqual({ first_name: 'Marco', license_number: '100003' })
    expect(clubFillOf({ first_name: 'Marco', last_name: 'Probe', license_number: '100003' }, MARCO)).toEqual({})
    // never a date of birth, also from an older copy of the lists
    expect(clubFillOf({ first_name: 'Marco', last_name: 'Probe', license_number: '100003' }, { ...MARCO, dob: '2001-11-02' })).toEqual({})
    expect(clubFillOf({ last_name: 'x' }, null)).toEqual({})
  })
  it('a linked row takes the club person\'s names and licence, and keeps its own fields', () => {
    const row = { key: 'k1', number: '7', first_name: 'Zoe', last_name: 'Muller', license_number: '', is_libero: true }
    expect(linkRowToClubPerson(row, { ...ZOE, dob: '1999-01-02' })).toEqual({ key: 'k1', number: '7', first_name: 'Zoé', last_name: 'Müller', license_number: '100005', is_libero: true })
  })
})

describe('handTypedForClub', () => {
  it('offers the ones typed by hand with a licence number: players to the players list (team gender), officials to the coaches list', () => {
    const players = [
      { first_name: 'Marco', last_name: 'Probe', license_number: '100003' },
      { first_name: 'Hans', last_name: 'Hand', license_number: '400001' },
      { first_name: 'Hans', last_name: 'Hand', license_number: '400001' },
      { first_name: 'Ohne', last_name: 'Nummer', license_number: '' },
      { first_name: '', last_name: '', license_number: '400009' }
    ]
    const staff = [
      { role: 'Coach', first_name: 'Pia', last_name: 'Coach', license_number: '500001' },
      { role: 'Physiotherapist', first_name: 'Phil', last_name: 'Physio', license_number: null },
      { role: 'Assistant Coach 1', first_name: 'Zoé', last_name: 'Müller', license_number: '100005' }
    ]
    const r = handTypedForClub(players, staff, PEOPLE, 'm')
    expect(r.offer).toEqual([
      { key: 'players:400001', list: 'players', name: 'Hans Hand', person: { sv_number: '400001', last_name: 'Hand', first_name: 'Hans', gender: 'm' } },
      { key: 'coaches:500001', list: 'coaches', name: 'Pia Coach', person: { sv_number: '500001', last_name: 'Coach', first_name: 'Pia', gender: null } }
    ])
    expect(r.noLicence).toEqual(['Ohne Nummer', 'Phil Physio'])
  })
  it('no gender for a team whose gender is unknown', () => {
    const r = handTypedForClub([{ first_name: 'Hans', last_name: 'Hand', license_number: '400001' }], [], PEOPLE, null)
    expect(r.offer[0].person.gender).toBeNull()
  })
})
