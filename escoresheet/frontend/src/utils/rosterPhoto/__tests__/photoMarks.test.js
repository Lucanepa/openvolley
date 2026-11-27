// A photo's marks on the roster editor's rows (owner 27.11.2026: the photo
// goes straight into the roster, the unsure fields are fixed there): keyed by
// a token on each row, shown while the field holds the photo's value, never
// part of what is stored or sent. Made-up people.
import { describe, it, expect } from 'vitest'
import { importedRosterOf, importedToSetup } from '../../../domain/importedRoster'
import { PHOTO_ROW, carryPhotoTokens, marksLeft, officialMarkOf, photoMarksOf, photoRowsIn, playerMarkOf, sameValue } from '../photoMarks'

const photo = () => importedRosterOf({
  players: [
    { number: 7, licence: '123451', firstName: 'Lia', lastName: 'Exempel', isCaptain: true, confidence: { number: 0.95, lastName: 0.95, firstName: 0.95, licence: 0.95 } },
    { number: 7, licence: '123452', firstName: 'Noa', lastName: 'Muslr', confidence: { number: 0.9, lastName: 0.4, firstName: 0.95, licence: 0.95 } },
    { number: 9, licence: '', firstName: 'Ida', lastName: 'Probe', isLibero: true, confidence: { isLibero: 0.5 } }
  ],
  coach: { firstName: 'Hxns', lastName: 'Muster', licence: '10001', confidence: { firstName: 0.3 } }
}, 'ocr')

function setup () {
  const imported = photo()
  const { players, bench } = importedToSetup(imported, { idMode: 'licence' })
  return { imported, bench, ...photoMarksOf(imported, players, bench) }
}

describe('photoMarksOf', () => {
  it('marks the fields fieldIssues names, on the editor\'s own fields', () => {
    const { players, bench, rowMarks, officialMarks, total } = setup()
    const st = { rowMarks, officialMarks }
    // 7 twice: both red; the unsure last name amber; no licence read: amber (in `dob`); the unsure libero amber
    expect(playerMarkOf(st, players[0], 'number')).toMatchObject({ level: 'invalid', reason: 'duplicateNumber' })
    expect(playerMarkOf(st, players[1], 'number')).toMatchObject({ level: 'invalid' })
    expect(playerMarkOf(st, players[1], 'lastName')).toMatchObject({ level: 'low', reason: 'unsure' })
    expect(playerMarkOf(st, players[2], 'dob')).toMatchObject({ level: 'low', reason: 'missingLicence' })
    expect(playerMarkOf(st, players[2], 'libero')).toMatchObject({ level: 'low' })
    expect(playerMarkOf(st, players[0], 'lastName')).toBeNull()
    // the coach's first name, by its bench role
    expect(officialMarkOf(st, bench.find(b => b.role === 'Coach'), 'firstName')).toMatchObject({ level: 'low' })
    expect(total).toBe(6)
    expect(marksLeft(st, players, bench)).toEqual({ invalid: 2, low: 4 })
    expect(photoRowsIn(players)).toBe(3)
  })

  it('a field edited loses its mark, the row keeps its others; a row rebuilt or new has none', () => {
    const { players, bench, rowMarks, officialMarks } = setup()
    const st = { rowMarks, officialMarks }
    const edited = { ...players[1], lastName: 'Musler' }
    expect(playerMarkOf(st, edited, 'lastName')).toBeNull()
    expect(playerMarkOf(st, edited, 'number')).toMatchObject({ level: 'invalid' })
    // the number fixed on one row: that row's mark goes (the other keeps its own until changed)
    expect(playerMarkOf(st, { ...players[1], number: 12 }, 'number')).toBeNull()
    expect(playerMarkOf(st, { lastName: 'Muslr', number: 7 }, 'lastName')).toBeNull()
    const coach = { ...bench.find(b => b.role === 'Coach'), firstName: 'Hans' }
    expect(officialMarkOf(st, coach, 'firstName')).toBeNull()
    expect(marksLeft(st, [players[0], edited, players[2]], [coach])).toEqual({ invalid: 2, low: 2 })
  })

  it('the token never leaves the editor: JSON and structured clone (IndexedDB) drop it', () => {
    const { players } = setup()
    expect(players.every(p => typeof p[PHOTO_ROW] === 'symbol')).toBe(true)
    expect(Object.keys(players[0])).not.toContain(String(PHOTO_ROW))
    const json = JSON.parse(JSON.stringify(players))
    expect(json.every(p => Object.getOwnPropertySymbols(p).length === 0)).toBe(true)
    const cloned = structuredClone(players)
    expect(cloned.every(p => Object.getOwnPropertySymbols(p).length === 0)).toBe(true)
    expect(JSON.stringify(players)).not.toMatch(/unsure|invalid|duplicateNumber|photo/i)
  })

  it('carryPhotoTokens: rows rebuilt from the photo\'s ("tick who plays") get their tokens back, by licence, else name', () => {
    const { players, rowMarks, officialMarks } = setup()
    const rebuilt = [
      { number: 7, lastName: 'Exempel', firstName: 'Lia', dob: '123451' },
      { number: 9, lastName: 'Probe', firstName: 'Ida', dob: '' },
      { number: 4, lastName: 'Neu', firstName: 'Nina', dob: '' }
    ]
    const carried = carryPhotoTokens(rebuilt, players)
    expect(carried[0][PHOTO_ROW]).toBe(players[0][PHOTO_ROW])
    expect(carried[1][PHOTO_ROW]).toBe(players[2][PHOTO_ROW])
    expect(carried[2][PHOTO_ROW]).toBeUndefined()
    expect(playerMarkOf({ rowMarks, officialMarks }, carried[0], 'number')).toMatchObject({ level: 'invalid' })
  })

  it('sameValue: blanks are alike, booleans by truth, the rest as text', () => {
    expect(sameValue('', null)).toBe(true)
    expect(sameValue(false, undefined)).toBe(true)
    expect(sameValue(true, false)).toBe(false)
    expect(sameValue(7, '7')).toBe(true)
    expect(sameValue('Muster ', 'Muster')).toBe(true)
    expect(sameValue('Musler', 'Muslr')).toBe(false)
  })
})
