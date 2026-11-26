import { describe, it, expect } from 'vitest'
import { fieldIssues, importedRosterOf, importedToSetup, validateImportedRoster, IMPORT_MAX_PLAYERS } from '../importedRoster'
import { importedIdValue } from '../idMode'
import { fillNumbersFromSaved } from '../savedTeams'

// Made-up people
const pdfResult = {
  players: [
    { number: null, licence: '123451', firstName: 'Luca', lastName: 'Exempel', dob: '14/03/2004', isLfp: false },
    { number: null, licence: '123452', firstName: 'Noé', lastName: 'Muster', dob: '02/11/2001', isLfp: true }
  ],
  coach: { firstName: 'Hans', lastName: 'Muster', dob: '', birthYear: '1980', licence: '10001' },
  ac1: null,
  ac2: null
}
const savedTeam = {
  players: [
    { number: 7, first_name: 'Luca', last_name: 'Exempel', license_number: '123451', active: true },
    { number: 9, first_name: 'Noé', last_name: 'Muster', license_number: '123452', active: true }
  ],
  staff: []
}

describe('importedRosterOf: the one structure of every reader', () => {
  it('keeps the parser fields, adds the captain and libero flags, drops unknown keys', () => {
    const r = importedRosterOf({ ...pdfResult, extra: 'x' }, 'pdf')
    expect(r.source).toBe('pdf')
    expect(r.players[0]).toEqual({ number: null, licence: '123451', firstName: 'Luca', lastName: 'Exempel', dob: '14/03/2004', isLfp: false, isCaptain: false, isLibero: false })
    expect(r.coach).toEqual({ firstName: 'Hans', lastName: 'Muster', licence: '10001' })
    expect(r).not.toHaveProperty('extra')
    expect(validateImportedRoster(r)).toEqual({ ok: true, errors: [] })
  })

  it('trims and cuts strings, keeps confidences in 0..1, leaves out rows without a name', () => {
    const r = importedRosterOf({
      players: [
        { firstName: '  Anna  Maria ', lastName: 'X'.repeat(80), licence: ' 12 345 ', number: '7', confidence: { licence: 1.4, firstName: -1, nope: 0.5 } },
        { firstName: '', lastName: '' },
        'not a row'
      ]
    }, 'ocr')
    expect(r.players).toHaveLength(1)
    expect(r.players[0]).toMatchObject({ firstName: 'Anna Maria', licence: '12345', number: 7 })
    expect(r.players[0].lastName).toHaveLength(60)
    expect(r.players[0].confidence).toEqual({ licence: 1, firstName: 0 })
  })

  it('an official without a name is none', () => {
    expect(importedRosterOf({ players: [], coach: { firstName: '', lastName: '', licence: '10001' } }, 'ocr').coach).toBeNull()
  })

  it('a photo has at most IMPORT_MAX_PLAYERS rows; a PDF keeps them all', () => {
    const many = { players: Array.from({ length: IMPORT_MAX_PLAYERS + 5 }, (_, i) => ({ firstName: 'A', lastName: `B${i}` })) }
    expect(importedRosterOf(many, 'ocr').players).toHaveLength(IMPORT_MAX_PLAYERS)
    expect(importedRosterOf(many, 'pdf').players).toHaveLength(IMPORT_MAX_PLAYERS + 5)
  })
})

describe('validateImportedRoster: the shape', () => {
  it('names what is wrong', () => {
    expect(validateImportedRoster(null).ok).toBe(false)
    const { ok, errors } = validateImportedRoster({
      source: 'fax',
      players: [{ firstName: 1, lastName: 'A', licence: '', number: 1.5, isCaptain: 'yes', isLibero: false, isLfp: false, confidence: { number: 2 } }],
      coach: 'Hans'
    })
    expect(ok).toBe(false)
    expect(errors).toEqual(expect.arrayContaining([
      { path: 'source', code: 'value' },
      { path: 'players.0.firstName', code: 'type' },
      { path: 'players.0.number', code: 'type' },
      { path: 'players.0.isCaptain', code: 'type' },
      { path: 'players.0.confidence.number', code: 'value' },
      { path: 'coach', code: 'type' }
    ]))
  })
})

describe('fieldIssues: what the confirm screen marks', () => {
  const roster = (players, extra = {}) => importedRosterOf({ players, ...extra }, 'ocr')

  it('red: a number out of range or twice, a bad licence, no last name, two captains, three liberos, a libero captain', () => {
    const r = roster([
      { number: 4, licence: '123451', firstName: 'A', lastName: 'Aa', isCaptain: true },
      { number: 4, licence: '12a45', firstName: 'B', lastName: 'Bb', isCaptain: true },
      { number: 120, licence: '123453', firstName: 'C', lastName: 'Cc', isLibero: true },
      { number: 5, licence: '123454', firstName: 'D', lastName: '', isLibero: true },
      { number: 6, licence: '123455', firstName: 'E', lastName: 'Ee', isLibero: true, isCaptain: false }
    ])
    // (importedRosterOf keeps digits only: "12a45" is "1245", a licence too short)
    const { players, blocking } = fieldIssues(r)
    expect(blocking).toBe(true)
    expect(players[0].number).toEqual({ level: 'invalid', reason: 'duplicateNumber' })
    expect(players[1].number.reason).toBe('duplicateNumber')
    expect(players[1].licence).toEqual({ level: 'invalid', reason: 'licence' })
    expect(players[2].number.reason).toBe('number')
    expect(players[3].lastName.reason).toBe('missingName')
    expect(players[0].isCaptain.reason).toBe('twoCaptains')
    expect(players[4].isLibero.reason).toBe('tooManyLiberos')
    const libCap = fieldIssues(roster([{ number: 1, licence: '123451', firstName: 'A', lastName: 'Aa', isCaptain: true, isLibero: true }]))
    expect(libCap.players[0].isCaptain).toEqual({ level: 'invalid', reason: 'captainLibero' })
  })

  it('amber: unsure, no licence read, digits in a name; nothing blocks', () => {
    const r = roster([
      { number: 7, licence: '123451', firstName: 'Piotr', lastName: 'Krawczynski', confidence: { lastName: 0.43, number: 0.7 } },
      { number: null, licence: '', firstName: 'Mül1er', lastName: 'Sven' }
    ])
    const { players, blocking } = fieldIssues(r)
    expect(blocking).toBe(false)
    expect(players[0].lastName).toEqual({ level: 'low', reason: 'unsure' })
    expect(players[0].number).toEqual({ level: 'low', reason: 'unsure' })
    expect(players[0].licence).toBeUndefined()
    expect(players[1].licence).toEqual({ level: 'low', reason: 'missingLicence' })
    expect(players[1].firstName).toEqual({ level: 'low', reason: 'odd' })
  })

  it('officials: an empty row is no one, a licence without a name is not', () => {
    expect(fieldIssues({ source: 'ocr', players: [], coach: { firstName: '', lastName: '', licence: '' } }).blocking).toBe(false)
    const r = fieldIssues({ source: 'ocr', players: [], coach: { firstName: '', lastName: '', licence: '10001' }, ac1: { firstName: 'Anna', lastName: 'Rossi', licence: '1' } })
    expect(r.officials.coach.lastName.reason).toBe('missingName')
    expect(r.officials.ac1.licence.reason).toBe('licence')
    expect(r.blocking).toBe(true)
  })
})

describe('importedToSetup: the one way a PDF and a photo are taken', () => {
  it('a PDF gives exactly what the PDF import gave before (MatchSetup, until 26.11.6)', () => {
    // the old handleHomePdfUpload mapping, kept here as the reference
    const before = (parsed, idMode, team) => {
      const { roster, filled } = fillNumbersFromSaved(parsed.players.map(p => ({
        id: null, number: p.number || null, firstName: p.firstName || '', lastName: p.lastName || '',
        dob: importedIdValue(p, idMode), libero: '', isCaptain: false, isLfp: p.isLfp || false
      })), team)
      const bench = []
      for (const [k, role] of [['coach', 'Coach'], ['ac1', 'Assistant Coach 1'], ['ac2', 'Assistant Coach 2']]) {
        if (parsed[k]) bench.push({ role, firstName: parsed[k].firstName || '', lastName: parsed[k].lastName || '', dob: importedIdValue(parsed[k], idMode) })
      }
      return { players: roster, bench, numbersFilled: filled }
    }
    for (const idMode of ['licence', 'dob']) {
      for (const team of [null, savedTeam]) {
        expect(importedToSetup(importedRosterOf(pdfResult, 'pdf'), { idMode, savedTeam: team })).toEqual(before(pdfResult, idMode, team))
      }
    }
  })

  it('a photo: the list\'s numbers, captain and liberos for this game; blanks from the saved team', () => {
    const photo = importedRosterOf({
      players: [
        { number: 12, licence: '123451', firstName: 'Luca', lastName: 'Exempel', isCaptain: true },
        { number: null, licence: '123452', firstName: 'Noé', lastName: 'Muster', isLibero: true },
        { number: 3, licence: '123453', firstName: 'Jonas', lastName: 'Beispiel', isLibero: true, isCaptain: true },
        { number: 4, licence: '123454', firstName: 'Marco', lastName: 'Rossi', isLibero: true }
      ]
    }, 'ocr')
    const { players, numbersFilled } = importedToSetup(photo, { idMode: 'licence', savedTeam })
    // 12 is the list's (the saved team says 7); Muster has none on the list: 9 from the saved team
    expect(players.map(p => p.number)).toEqual([12, 9, 3, 4])
    expect(numbersFilled).toBe(1)
    // the first captain only; the first two liberos only
    expect(players.map(p => p.isCaptain)).toEqual([true, false, false, false])
    expect(players.map(p => p.libero)).toEqual(['', 'libero1', 'libero2', ''])
    expect(players[0].dob).toBe('123451')
  })
})
