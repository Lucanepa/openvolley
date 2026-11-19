// Owner 2026-11-19: "next games ... the numbers can be automatically filled
// with roster (einsatzliste) import". The server keeps the latest official
// match's shirt numbers in the team's saved team (backend
// lib/rosterSaveBack.js); Match Setup (the device's copy) and the manager
// (the squad as stored) fill them into an Einsatzliste and "Add from club".
// Made-up people only.
import { describe, it, expect } from 'vitest'
import { fillNumbersFromSaved, savedNumberFinder } from '../savedTeams'
import { addClubPlayersToRoster } from '../clubPlayers'
import { addClubPlayersToGameDraft, addClubPlayersToSquad, applyEinsatzlisteToGameDraft, gameRosterDraft, mergeImportedRoster, parsedPdfToRoster } from '../teamRosters'

const saved = {
  players: [
    { id: 'a', number: 9, first_name: 'Marco', last_name: 'Probe', license_number: '100003', active: true },
    { id: 'b', number: 4, first_name: 'Léa', last_name: 'Müller', license_number: null, active: true },
    { id: 'c', number: 15, first_name: 'Gone', last_name: 'Away', license_number: '100009', active: false },
    { id: 'd', number: 4, first_name: 'Old', last_name: 'Four', license_number: '100010', active: false },
    { id: 'e', number: 7, first_name: 'Twin', last_name: 'Same', license_number: null, active: true },
    { id: 'f', number: 8, first_name: 'Twin', last_name: 'Same', license_number: null, active: true },
    { id: 'g', number: null, first_name: 'No', last_name: 'Number', license_number: '100011', active: true }
  ],
  staff: []
}
const row = (number, firstName, lastName, dob = '') => ({ number, firstName, lastName, dob, libero: '', isCaptain: false, isLfp: false })

describe('savedNumberFinder', () => {
  const numberOf = savedNumberFinder(saved)
  it('by licence, else by name (accents, case, swapped names)', () => {
    expect(numberOf({ licence: '100003', firstName: 'X', lastName: 'Y' })).toBe(9)
    expect(numberOf({ firstName: 'lea', lastName: 'MULLER' })).toBe(4)
    expect(numberOf({ firstName: 'Muller', lastName: 'Lea' })).toBe(4)
    // a licence the saved player has not got: still the name (Léa has none)
    expect(numberOf({ licence: '100004', firstName: 'Lea', lastName: 'Muller' })).toBe(4)
  })
  it('nothing when it can\'t tell: another licence, two of that name, no number, unknown, inactive', () => {
    expect(numberOf({ licence: '999999', firstName: 'Marco', lastName: 'Probe' })).toBe(null)
    expect(numberOf({ firstName: 'Twin', lastName: 'Same' })).toBe(null)
    expect(numberOf({ licence: '100011', firstName: 'No', lastName: 'Number' })).toBe(null)
    expect(numberOf({ firstName: 'Nobody', lastName: 'Here' })).toBe(null)
    expect(numberOf({ licence: '100009' })).toBe(null)
    expect(savedNumberFinder(null)({ licence: '100003' })).toBe(null)
  })
  it('inactive players with `inactive`, unless an active one wears the number', () => {
    const withInactive = savedNumberFinder(saved, { inactive: true })
    expect(withInactive({ licence: '100009' })).toBe(15)
    expect(withInactive({ licence: '100010' })).toBe(null)
  })
})

describe('Match Setup: fillNumbersFromSaved and Add from club', () => {
  it('an Einsatzliste\'s rows without a number get the saved team\'s; a number never twice', () => {
    const { roster, filled } = fillNumbersFromSaved([
      row(null, 'Marco', 'Probe', '100003'),
      row(null, 'Lea', 'Muller', '100004'),
      row(9, 'Own', 'Nine', '100012'),
      row(null, 'Neu', 'Unbekannt', '100006'),
      // a date of birth the scorer typed tells nothing: the name does
      row(null, 'Léa', 'Müller', '14.03.2008')
    ], saved)
    expect(roster.map((p) => p.number)).toEqual([null, 4, 9, null, null])
    expect(filled).toBe(1)
    expect(fillNumbersFromSaved([row(null, 'Marco', 'Probe', '100003')], null).roster[0].number).toBe(null)
  })

  it('Add from club: the saved team\'s number, when the roster has not got it', () => {
    const { roster, added, numbered } = addClubPlayersToRoster([row(4, 'Some', 'One')], [
      { sv_number: '100003', last_name: 'Probe', first_name: 'Marco' },
      { sv_number: '100013', last_name: 'Müller', first_name: 'Léa' },
      { sv_number: '100014', last_name: 'Neu', first_name: 'Nina' }
    ], saved)
    expect(roster.map((p) => [p.lastName, p.number, p.dob])).toEqual([['One', 4, ''], ['Probe', 9, '100003'], ['Müller', null, '100013'], ['Neu', null, '100014']])
    expect([added, numbered]).toEqual([3, 1])
    // without a saved team: as before
    expect(addClubPlayersToRoster([], [{ sv_number: '100003', last_name: 'Probe', first_name: 'Marco' }]).roster[0].number).toBe(null)
  })
})

describe('the manager: game roster drafts and the squad editor', () => {
  // the squad as stored: the active players are offered in the draft, Gone (inactive) is not
  const squad = saved
  const draft = () => gameRosterDraft(squad, null)
  const pdf = (players) => parsedPdfToRoster({ players: players.map(([firstName, lastName, licence]) => ({ firstName, lastName, licence })) })

  it('an Einsatzliste for a game: a player not offered gets the saved team\'s number (one set inactive too)', () => {
    const { draft: out, added } = applyEinsatzlisteToGameDraft(draft(), pdf([['Marco', 'Probe', '100003'], ['Gone', 'Away', '100009'], ['Neu', 'Person', '100015']]), squad)
    const ticked = out.players.filter((p) => p.picked)
    expect(ticked.map((p) => [p.last_name, p.number])).toEqual([['Probe', 9], ['Away', 15], ['Person', '']])
    expect(added).toBe(2)
    expect(out.players.some((p) => 'fresh' in p)).toBe(false)
    // without the squad: as before
    const plain = applyEinsatzlisteToGameDraft(draft(), pdf([['Gone', 'Away', '100009']])).draft
    expect(plain.players.find((p) => p.last_name === 'Away').number).toBe('')
  })

  it('an Einsatzliste: never a number a ticked player has', () => {
    const d = draft()
    // Probe ticked with 15 already
    d.players = d.players.map((p) => (p.last_name === 'Probe' ? { ...p, number: 15 } : p))
    const { draft: out } = applyEinsatzlisteToGameDraft(d, pdf([['Marco', 'Probe', '100003'], ['Gone', 'Away', '100009']]), squad)
    expect(out.players.filter((p) => p.picked).map((p) => [p.last_name, p.number])).toEqual([['Probe', 15], ['Away', '']])
  })

  it('Add from club to a game: the saved team\'s number unless a ticked player wears it', () => {
    const { draft: out, added } = addClubPlayersToGameDraft(draft(), [{ sv_number: '100009', last_name: 'Away', first_name: 'Gone' }], squad)
    expect(added).toBe(1)
    expect(out.players.find((p) => p.last_name === 'Away').number).toBe(15)
    const d = draft()
    d.players = d.players.map((p) => (p.last_name === 'Probe' ? { ...p, number: 15, picked: true } : p))
    expect(addClubPlayersToGameDraft(d, [{ sv_number: '100009', last_name: 'Away', first_name: 'Gone' }], squad).draft.players.find((p) => p.last_name === 'Away').number).toBe('')
  })

  it('the squad editor: a player removed from the list and imported again gets the stored number back', () => {
    // the editor's list without Gone; the stored squad has them (inactive) with 15
    const editor = squad.players.filter((p) => p.id !== 'c')
    const m = mergeImportedRoster(editor, [], pdf([['Gone', 'Away', '100009'], ['Neu', 'Person', '100015']]), (p) => p, (s) => s, squad)
    expect(m.players.slice(-2).map((p) => [p.last_name, p.number])).toEqual([['Away', 15], ['Person', null]])
    const c = addClubPlayersToSquad(editor, [], [{ sv_number: '100009', last_name: 'Away', first_name: 'Gone' }], (p) => p, (s) => s, squad)
    expect(c.players.at(-1).number).toBe(15)
    // an active player of the list wears it: none
    const worn = mergeImportedRoster([...editor, { number: 15, first_name: 'Has', last_name: 'Fifteen', license_number: null, active: true }], [], pdf([['Gone', 'Away', '100009']]), (p) => p, (s) => s, squad)
    expect(worn.players.at(-1).number).toBe(null)
  })
})
