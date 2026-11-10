import { describe, it, expect } from 'vitest'
import { applyClubFill, clubFillOfRow, clubPersonOfRow, linkRowToClub } from '../clubPlayers'

// Match Setup's shields (owner 2026-11-10): its rows have no licence number,
// so a row is a club person by name and, when both have one, the date of
// birth. Made-up people.

const ANNA = { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f', lists: ['players'], manual: false }
const ZOE = { sv_number: '100005', last_name: 'Müller', first_name: 'Zoé', dob: null, gender: 'f', lists: ['coaches'], manual: false }
const HANS = { sv_number: '400001', last_name: 'Hand', first_name: 'Hans', dob: '2000-01-01', gender: 'm', lists: ['players'], manual: true }
const PEOPLE = [ANNA, ZOE, HANS]

describe('clubPersonOfRow', () => {
  it('by name (accents, case, order aside), and the date of birth when both have one', () => {
    expect(clubPersonOfRow({ firstName: 'anna', lastName: 'BEISPIEL', dob: '06.05.2004' }, PEOPLE)).toBe(ANNA)
    expect(clubPersonOfRow({ firstName: 'Beispiel', lastName: 'Anna', dob: '' }, PEOPLE)).toBe(ANNA)
    expect(clubPersonOfRow({ firstName: 'Zoe', lastName: 'Muller', dob: '01.02.1999' }, PEOPLE)).toBe(ZOE)
    // kept by hand: found (the shield is gray for it)
    expect(clubPersonOfRow({ firstName: 'Hans', lastName: 'Hand', dob: '' }, PEOPLE)).toBe(HANS)
  })
  it('another date of birth, an unknown name, two of the same name or no lists: typed by hand', () => {
    expect(clubPersonOfRow({ firstName: 'Anna', lastName: 'Beispiel', dob: '07.05.2004' }, PEOPLE)).toBeNull()
    expect(clubPersonOfRow({ firstName: 'Nina', lastName: 'Neu' }, PEOPLE)).toBeNull()
    const twin = { ...ANNA, sv_number: '100009' }
    expect(clubPersonOfRow({ firstName: 'Anna', lastName: 'Beispiel' }, [ANNA, twin])).toBeNull()
    expect(clubPersonOfRow({ firstName: 'Anna', lastName: 'Beispiel' }, [])).toBeNull()
    expect(clubPersonOfRow({ firstName: 'Anna', lastName: '' }, PEOPLE)).toBeNull()
  })
  it('one uploaded among others kept by hand: the uploaded one', () => {
    const kept = { ...ANNA, sv_number: '400002', manual: true }
    expect(clubPersonOfRow({ firstName: 'Anna', lastName: 'Beispiel' }, [kept, ANNA])).toBe(ANNA)
  })
})

describe('fill and link', () => {
  it('fills only the first name and date of birth the row lacks, in its formats', () => {
    const row = { firstName: '', lastName: 'Beispiel', dob: '', number: 7 }
    const fill = clubFillOfRow(row, ANNA)
    expect(fill).toEqual({ first_name: 'Anna', dob: '06.05.2004' })
    expect(applyClubFill(row, fill)).toEqual({ firstName: 'Anna', lastName: 'Beispiel', dob: '06.05.2004', number: 7 })
    expect(clubFillOfRow({ firstName: 'Anna', lastName: 'Beispiel', dob: '06.05.2004' }, ANNA)).toEqual({})
  })
  it('a linked row takes the club person\'s names and date of birth and keeps the rest', () => {
    expect(linkRowToClub({ role: 'Coach', firstName: 'Zoe', lastName: 'Muller', dob: '01.02.1999' }, ZOE))
      .toEqual({ role: 'Coach', firstName: 'Zoé', lastName: 'Müller', dob: '01.02.1999' })
    expect(linkRowToClub({ number: 4, firstName: 'A.', lastName: 'Beisp', dob: '', libero: '' }, ANNA))
      .toEqual({ number: 4, firstName: 'Anna', lastName: 'Beispiel', dob: '06.05.2004', libero: '' })
  })
})
