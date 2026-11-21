import { describe, it, expect } from 'vitest'
import { playerReplacedByLibero, playersForLiberoRedesignation } from '../liberos'

// What Scoreboard writes for a libero replacement: the libero_entry event
// (playerOut / liberoIn) and its lineup sub-event (seq N.1) whose
// liberoSubstitution names the replaced player; a rotation lineup carries the
// liberoSubstitution on with the libero's new position.
const entry = (seq, { team = 'home', setIndex = 1, position, playerOut, liberoIn }) => [
  { id: `e${seq}`, seq, setIndex, type: 'libero_entry', payload: { team, position, playerOut, liberoIn, liberoType: 'libero1' } },
  {
    id: `l${seq}`, seq: seq + 0.1, setIndex, type: 'lineup',
    payload: { team, lineup: {}, liberoSubstitution: { position, liberoNumber: liberoIn, playerNumber: playerOut, liberoType: 'libero1' } }
  }
]

describe('playerReplacedByLibero (FIVB 19.3.2.1: the libero is replaced only by the player he/she replaced)', () => {
  it('finds the player from the libero_entry (playerOut), not from a playerNumber it never stores', () => {
    const events = [{ id: 'e3', seq: 3, setIndex: 1, type: 'libero_entry', payload: { team: 'home', position: 'VI', playerOut: 7, liberoIn: 12 } }]
    expect(playerReplacedByLibero(events, 'home', 1, 12)).toBe(7)
  })

  it('still finds the player after the libero rotated to another position', () => {
    const events = [
      ...entry(3, { position: 'VI', playerOut: 7, liberoIn: 12 }),
      { id: 'p4', seq: 4, setIndex: 1, type: 'point', payload: { team: 'home' } },
      {
        id: 'r4', seq: 4.1, setIndex: 1, type: 'lineup',
        payload: { team: 'home', lineup: {}, liberoSubstitution: { position: 'V', liberoNumber: 12, playerNumber: 7, liberoType: 'libero1' } }
      }
    ]
    expect(playerReplacedByLibero(events, 'home', 1, 12)).toBe(7)
    expect(playerReplacedByLibero(events, 'home', 1, '12')).toBe(7)
  })

  it('after a libero exchange, the second libero stands for the same player', () => {
    const events = [
      ...entry(3, { position: 'V', playerOut: 7, liberoIn: 12 }),
      { id: 'x5', seq: 5, setIndex: 1, type: 'libero_exchange', payload: { team: 'home', position: 'V', liberoOut: 12, liberoIn: 15, playerNumber: 7 } },
      {
        id: 'xl5', seq: 5.1, setIndex: 1, type: 'lineup',
        payload: { team: 'home', lineup: {}, liberoSubstitution: { position: 'V', liberoNumber: 15, playerNumber: 7, liberoType: 'libero2' } }
      }
    ]
    expect(playerReplacedByLibero(events, 'home', 1, 15)).toBe(7)
    // without the lineup sub-event (older data), the exchange event itself
    expect(playerReplacedByLibero(events.filter(e => e.id !== 'xl5'), 'home', 1, 15)).toBe(7)
  })

  it('takes the latest replacement when the libero came back for another player', () => {
    const events = [
      ...entry(3, { position: 'V', playerOut: 7, liberoIn: 12 }),
      { id: 'x4', seq: 4, setIndex: 1, type: 'libero_exit', payload: { team: 'home', position: 'V', liberoOut: 12, playerIn: 7 } },
      ...entry(6, { position: 'VI', playerOut: 9, liberoIn: 12 })
    ]
    expect(playerReplacedByLibero(events, 'home', 1, 12)).toBe(9)
  })

  it('ignores the other team, other sets and an unknown libero', () => {
    const events = [
      ...entry(3, { team: 'away', position: 'V', playerOut: 4, liberoIn: 12 }),
      ...entry(8, { setIndex: 2, position: 'V', playerOut: 5, liberoIn: 12 })
    ]
    expect(playerReplacedByLibero(events, 'home', 1, 12)).toBeNull()
    expect(playerReplacedByLibero(events, 'away', 1, 12)).toBe(4)
    expect(playerReplacedByLibero(events, 'home', 2, 12)).toBe(5)
    expect(playerReplacedByLibero(events, 'home', 1, 99)).toBeNull()
    expect(playerReplacedByLibero(null, 'home', 1, 12)).toBeNull()
  })
})

describe('playersForLiberoRedesignation (FIVB 19.4.2: only a player who may still play)', () => {
  // away: libero #1 (unable), players 2-12; #2 #4 #5 #6 #9 #12 on court
  const roster = [
    { id: 61, number: 1, libero: 'libero1' },
    ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => ({ id: 60 + n, number: n, libero: '' }))
  ]
  const onCourt = [2, 4, 5, 6, 9, 12]
  const list = (events, opts = {}) => playersForLiberoRedesignation(roster, events, 'away', { onCourt, unableLiberoNumber: 1, ...opts }).map(p => p.number)
  const sanction = (seq, playerNumber, type, setIndex = 1) => ({ seq, setIndex, type: 'sanction', payload: { team: 'away', type, playerType: 'player', playerNumber } })
  const sub = (seq, playerOut, playerIn, flags = {}, setIndex = 1) => ({ seq, setIndex, type: 'substitution', payload: { team: 'away', playerOut, playerIn, ...flags } })

  it('offers the bench players who are not liberos (never the unable libero)', () => {
    expect(list([])).toEqual([3, 7, 8, 10, 11])
  })

  it('leaves out a disqualified player (the 21.11 test: #3 was offered and accepted)', () => {
    const events = [sanction(5, 3, 'disqualification'), sub(5.1, 3, 8, { isDisqualified: true })]
    expect(list(events, { onCourt: [2, 4, 5, 6, 8, 12] })).toEqual([7, 9, 10, 11])
  })

  it('leaves out a player injured and replaced by an exceptional substitution: out for the match (FIVB 15.7)', () => {
    const events = [sub(9, 8, 9, { isExceptional: true, isInjury: true })]
    expect(list(events)).toEqual([3, 7, 10, 11])
  })

  it('keeps a player injured and replaced by a regular substitution (he may come back)', () => {
    expect(list([sub(9, 8, 3, { isInjury: true })], { onCourt: [2, 3, 4, 5, 6, 12] })).toEqual([7, 8, 9, 10, 11])
  })

  it('keeps a player expelled in this set, also when replaced exceptionally (back next set, 21.3.2; owner decision pending)', () => {
    expect(list([sanction(4, 7, 'expulsion'), sub(4.1, 7, 3, { isExpelled: true })], { onCourt: [2, 3, 4, 5, 6, 12] })).toContain(7)
    expect(list([sanction(4, 7, 'expulsion'), sub(4.1, 7, 10, { isExceptional: true, isExpelled: true })], { onCourt: [2, 4, 5, 6, 10, 12] })).toContain(7)
  })

  it('leaves out a disqualification of any set, also of a bench player, never another team\'s', () => {
    expect(list([{ ...sanction(3, 10, 'disqualification', 1), payload: { team: 'away', type: 'disqualification', playerType: 'bench', playerNumber: 10 } }])).not.toContain(10)
    expect(list([{ ...sanction(3, 10, 'disqualification'), payload: { team: 'home', type: 'disqualification', playerType: 'player', playerNumber: 10 } }])).toContain(10)
  })

  it('leaves out an earlier re-designation and any libero, matching numbers stored as strings', () => {
    const players = roster.map(p => (p.number === 11 ? { ...p, libero: 'redesignated' } : p.number === 7 ? { ...p, libero: 'unable' } : { ...p, number: String(p.number) }))
    const events = [{ seq: 6, setIndex: 1, type: 'libero_redesignation', payload: { team: 'away', unableLiberoNumber: 1, newLiberoNumber: '10' } }]
    expect(playersForLiberoRedesignation(players, events, 'away', { onCourt: ['2', 4, 5, 6, 9, 12], unableLiberoNumber: '1' }).map(p => Number(p.number))).toEqual([3, 8])
  })
})
