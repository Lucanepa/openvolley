import { describe, it, expect } from 'vitest'
import { clubFillOf, clubPersonOf, handTypedForClub, linkRowToClubPerson } from '../teamRosters'

// Green and gray shields (owner 2026-11-10): who of a roster is in the club's
// lists, and who typed by hand Save offers to keep there. Made-up people.

const ANNA = { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f', lists: ['players'] }
const MARCO = { sv_number: '100003', last_name: 'Probe', first_name: 'Marco', dob: '2001-11-02', gender: 'm', lists: ['players', 'coaches'] }
const ZOE = { sv_number: '100005', last_name: 'Müller', first_name: 'Zoé', dob: '1999-01-02', gender: 'f', lists: ['coaches'] }
const PEOPLE = [ANNA, MARCO, ZOE]

describe('clubPersonOf', () => {
  it('the same licence number is the club person, whatever the names say', () => {
    expect(clubPersonOf({ first_name: 'M.', last_name: 'P', license_number: ' 100003 ' }, PEOPLE)).toBe(MARCO)
  })
  it('without a known licence: the same name (accents, case, order aside) and the same date of birth', () => {
    expect(clubPersonOf({ first_name: 'zoe', last_name: 'MULLER', dob: '1999-01-02', license_number: '' }, PEOPLE)).toBe(ZOE)
    expect(clubPersonOf({ first_name: 'Probe', last_name: 'Marco', dob: '2001-11-02', license_number: null }, PEOPLE)).toBe(MARCO)
    // a licence the club does not know falls back to name and date of birth
    expect(clubPersonOf({ first_name: 'Anna', last_name: 'Beispiel', dob: '2004-05-06', license_number: '999999' }, PEOPLE)).toBe(ANNA)
  })
  it('one uploaded person among others kept by hand with the same name and date of birth: the uploaded one', () => {
    const kept = { ...ANNA, sv_number: '400002', manual: true }
    expect(clubPersonOf({ first_name: 'Anna', last_name: 'Beispiel', dob: '2004-05-06' }, [kept, ANNA])).toBe(ANNA)
  })
  it('a name alone, another date of birth, two candidates or no lists: typed by hand (null)', () => {
    expect(clubPersonOf({ first_name: 'Anna', last_name: 'Beispiel', dob: '', license_number: '' }, PEOPLE)).toBeNull()
    expect(clubPersonOf({ first_name: 'Anna', last_name: 'Beispiel', dob: '2004-05-07' }, PEOPLE)).toBeNull()
    const twin = { ...ANNA, sv_number: '100009' }
    expect(clubPersonOf({ first_name: 'Anna', last_name: 'Beispiel', dob: '2004-05-06' }, [ANNA, twin])).toBeNull()
    expect(clubPersonOf({ first_name: 'Anna', last_name: 'Beispiel', license_number: '100001' }, [])).toBeNull()
    expect(clubPersonOf(null, PEOPLE)).toBeNull()
  })
})

describe('clubFillOf and linkRowToClubPerson', () => {
  it('fills only what the row leaves empty', () => {
    expect(clubFillOf({ first_name: '', last_name: 'Probe', dob: '2001-11-02', license_number: '' }, MARCO)).toEqual({ first_name: 'Marco', license_number: '100003' })
    expect(clubFillOf({ first_name: 'Marco', last_name: 'Probe', dob: '2001-11-02', license_number: '100003' }, MARCO)).toEqual({})
    expect(clubFillOf({ last_name: 'x' }, null)).toEqual({})
  })
  it('a linked row takes the club person\'s names, date of birth and licence, and keeps its own fields', () => {
    const row = { key: 'k1', number: '7', first_name: 'Zoe', last_name: 'Muller', dob: '', license_number: '', is_libero: true }
    expect(linkRowToClubPerson(row, ZOE)).toEqual({ key: 'k1', number: '7', first_name: 'Zoé', last_name: 'Müller', dob: '1999-01-02', license_number: '100005', is_libero: true })
  })
})

describe('handTypedForClub', () => {
  it('offers the ones typed by hand with a licence number: players to the players list (team gender), officials to the coaches list', () => {
    const players = [
      { first_name: 'Marco', last_name: 'Probe', license_number: '100003' },
      { first_name: 'Hans', last_name: 'Hand', dob: '2000-01-01', license_number: '400001' },
      { first_name: 'Hans', last_name: 'Hand', dob: '2000-01-01', license_number: '400001' },
      { first_name: 'Ohne', last_name: 'Nummer', license_number: '' },
      { first_name: '', last_name: '', license_number: '400009' }
    ]
    const staff = [
      { role: 'Coach', first_name: 'Pia', last_name: 'Coach', dob: null, license_number: '500001' },
      { role: 'Physiotherapist', first_name: 'Phil', last_name: 'Physio', license_number: null },
      { role: 'Assistant Coach 1', first_name: 'Zoé', last_name: 'Müller', license_number: '100005' }
    ]
    const r = handTypedForClub(players, staff, PEOPLE, 'm')
    expect(r.offer).toEqual([
      { key: 'players:400001', list: 'players', name: 'Hans Hand', person: { sv_number: '400001', last_name: 'Hand', first_name: 'Hans', dob: '2000-01-01', gender: 'm' } },
      { key: 'coaches:500001', list: 'coaches', name: 'Pia Coach', person: { sv_number: '500001', last_name: 'Coach', first_name: 'Pia', dob: null, gender: null } }
    ])
    expect(r.noLicence).toEqual(['Ohne Nummer', 'Phil Physio'])
  })
  it('no gender for a team whose gender is unknown', () => {
    const r = handTypedForClub([{ first_name: 'Hans', last_name: 'Hand', license_number: '400001' }], [], PEOPLE, null)
    expect(r.offer[0].person.gender).toBeNull()
  })
})
