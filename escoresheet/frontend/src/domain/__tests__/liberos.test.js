import { describe, it, expect } from 'vitest'
import { playerReplacedByLibero, playersForLiberoRedesignation, liberoPlayState, liberoToReplaceByRedesignation, liberoReplacedByRedesignation, LIBERO_RECOVERED } from '../liberos'

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

  it('keeps a player expelled in this set and replaced legally (back next set, 21.3.2; owner decision pending)', () => {
    expect(list([sanction(4, 7, 'expulsion'), sub(4.1, 7, 3, { isExpelled: true })], { onCourt: [2, 3, 4, 5, 6, 12] })).toContain(7)
  })

  it('leaves out a player expelled or disqualified and replaced exceptionally: out for the match (owner 22.11.2026)', () => {
    expect(list([sanction(4, 7, 'expulsion'), sub(4.1, 7, 10, { isExceptional: true, isExpelled: true })], { onCourt: [2, 4, 5, 6, 10, 12] })).not.toContain(7)
    expect(list([sanction(4, 7, 'expulsion', 1), sub(4.1, 7, 10, { isExceptional: true, isExpelled: true }, 1)], { onCourt: [2, 4, 5, 6, 10, 12] })).toEqual([3, 8, 9, 11])
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

// Owner decision 22.11.2026: "If the injured libero got re-designated -> can't
// take part anymore in the game"; as long as no re-designation replaced him,
// the injured libero may come back (libero_recovered).
describe('liberoPlayState (FIVB 19.4.2; owner 22.11.2026)', () => {
  const unable = (seq, liberoNumber, reason, setIndex = 1) => ({ seq, setIndex, type: 'libero_unable', payload: { team: 'home', liberoNumber, liberoType: 'libero1', reason } })
  const back = (seq, liberoNumber, setIndex = 1) => ({ seq, setIndex, type: LIBERO_RECOVERED, payload: { team: 'home', liberoNumber, liberoType: 'libero1' } })
  const redesignation = (seq, unableLiberoNumber, newLiberoNumber) => ({ seq, setIndex: 1, type: 'libero_redesignation', payload: { team: 'home', unableLiberoNumber, newLiberoNumber, reason: 'injury' } })
  const sanction = (seq, playerNumber, type, setIndex = 1) => ({ seq, setIndex, type: 'sanction', payload: { team: 'home', type, playerType: 'libero', playerNumber } })
  const state = (events, opts = {}) => liberoPlayState(events, 'home', 12, { setIndex: 2, ...opts })

  it('a libero with nothing against him plays', () => {
    expect(state([])).toEqual({ unable: false, mayReturn: false, replaced: false })
  })

  it('injured: unable, may come back, in every later set (21.11: his tile did nothing in set 2)', () => {
    expect(state([unable(5, 12, 'injury')])).toEqual({ unable: true, mayReturn: true, replaced: false })
    expect(state([unable(5, 12, 'injury')], { setIndex: 4 }).mayReturn).toBe(true)
  })

  it('back (libero_recovered): plays again; injured again later: unable again', () => {
    expect(state([unable(5, 12, 'injury'), back(9, 12, 2)])).toEqual({ unable: false, mayReturn: false, replaced: false })
    expect(state([unable(5, 12, 'injury'), back(9, 12, 2), unable(12, 12, 'injury', 2)])).toMatchObject({ unable: true, mayReturn: true })
    // numbers stored as strings (a court disc) match
    expect(state([unable(5, '12', 'injury'), back(9, '12', 2)]).unable).toBe(false)
  })

  it('a re-designation in his place: out for the match, no way back (also by the roster mark alone)', () => {
    expect(state([unable(5, 12, 'injury'), redesignation(6, 12, 9)])).toEqual({ unable: true, mayReturn: false, replaced: true })
    // a recovery written before the re-designation does not bring him back
    expect(state([unable(5, 12, 'injury'), back(6, 12), unable(7, 12, 'injury'), redesignation(8, 12, 9)]).unable).toBe(true)
    expect(state([unable(5, 12, 'injury')], { player: { number: 12, libero: 'unable' } })).toMatchObject({ unable: true, mayReturn: false, replaced: true })
    expect(liberoReplacedByRedesignation([redesignation(6, '12', 9)], 'home', 12)).toBe(true)
    expect(liberoReplacedByRedesignation([redesignation(6, 12, 9)], 'away', 12)).toBe(false)
  })

  it('declared unable, or injured and declared: unable, no way back', () => {
    expect(state([unable(5, 12, 'declared')])).toEqual({ unable: true, mayReturn: false, replaced: false })
    expect(state([unable(5, 12, 'injury'), unable(6, 12, 'declared')]).mayReturn).toBe(false)
    // an older libero_unable without a reason: declared
    expect(state([{ ...unable(5, 12, undefined) }]).mayReturn).toBe(false)
  })

  // owner 22.11.2026: "Once declared or becoming unable and re-designated: can't continue playing"
  it('declared unable once: out for the match, also after a libero_recovered (a correction, an older record)', () => {
    expect(state([unable(5, 12, 'declared'), back(9, 12, 2)])).toEqual({ unable: true, mayReturn: false, replaced: false })
    // injured, back, then declared: out
    expect(state([unable(5, 12, 'injury'), back(6, 12), unable(7, 12, 'declared'), back(9, 12, 2)])).toEqual({ unable: true, mayReturn: false, replaced: false })
    // an injury entry edited to a declaration after his return: out
    expect(state([unable(5, 12, 'declared'), back(6, 12)], { setIndex: 4 }).unable).toBe(true)
    // only an injury (not declared, no re-designation) lets him come back
    expect(state([unable(5, 12, 'injury'), back(6, 12)]).unable).toBe(false)
    expect(state([unable(5, 12, 'injury'), back(6, 12), unable(7, 12, 'injury')]).mayReturn).toBe(true)
  })

  it('injured and re-designated: out for the match, also after a libero_recovered', () => {
    expect(state([unable(5, 12, 'injury'), redesignation(6, 12, 9), back(9, 12, 2)])).toEqual({ unable: true, mayReturn: false, replaced: true })
  })

  it('disqualified: out for the match; expelled: in that set only (21.3.2-21.3.3)', () => {
    expect(state([sanction(5, 12, 'disqualification', 1), unable(6, 12, 'disqualification', 1)])).toMatchObject({ unable: true, mayReturn: false })
    expect(state([sanction(5, 12, 'expulsion', 2), unable(6, 12, 'expulsion', 2)])).toMatchObject({ unable: true, mayReturn: false })
    expect(state([sanction(5, 12, 'expulsion', 1), unable(6, 12, 'expulsion', 1)])).toEqual({ unable: false, mayReturn: false, replaced: false })
    // injured AND disqualified: no way back
    expect(state([unable(4, 12, 'injury'), sanction(5, 12, 'disqualification', 1)]).mayReturn).toBe(false)
  })

  it('an injury substitution of the libero (older data) is an injury', () => {
    const injurySub = { seq: 5, setIndex: 1, type: 'substitution', payload: { team: 'home', playerOut: 12, playerIn: 7, isInjury: true } }
    expect(state([injurySub])).toEqual({ unable: true, mayReturn: true, replaced: false })
    expect(state([injurySub, back(6, 12)]).unable).toBe(false)
  })

  it('another libero\'s or the other team\'s events do not count', () => {
    expect(state([unable(5, 11, 'injury'), { ...unable(6, 12, 'injury'), payload: { ...unable(6, 12, 'injury').payload, team: 'away' } }]).unable).toBe(false)
  })
})

describe('liberoToReplaceByRedesignation: the libero a re-designation puts out for the match', () => {
  const roster = [
    { number: 11, libero: 'libero2' },
    { number: 12, libero: 'libero1' },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(number => ({ number, libero: '' }))
  ]
  const unable = (seq, liberoNumber, reason) => ({ seq, setIndex: 1, type: 'libero_unable', payload: { team: 'home', liberoNumber, reason } })
  const target = (events, players = roster) => liberoToReplaceByRedesignation(players, events, 'home', { setIndex: 1 })?.number ?? null

  it('none while no libero is unable; the unable one when only one is', () => {
    expect(target([])).toBe(null)
    expect(target([unable(5, 12, 'injury')])).toBe(12)
  })

  it('one who may not come back anyway (declared) before an injured one who may, whatever the order', () => {
    expect(target([unable(5, 11, 'declared'), unable(6, 12, 'injury')])).toBe(11)
    expect(target([unable(5, 12, 'injury'), unable(6, 11, 'declared')])).toBe(11)
  })

  it('both injured, or both declared: the latest to become unable', () => {
    expect(target([unable(5, 11, 'injury'), unable(6, 12, 'injury')])).toBe(12)
    expect(target([unable(5, 12, 'declared'), unable(6, 11, 'declared')])).toBe(11)
  })

  it('never one replaced before or back in play', () => {
    const replaced = { seq: 7, setIndex: 1, type: 'libero_redesignation', payload: { team: 'home', unableLiberoNumber: 11, newLiberoNumber: 9 } }
    expect(target([unable(5, 11, 'declared'), unable(6, 12, 'injury'), replaced])).toBe(12)
    expect(target([unable(5, 12, 'injury'), { seq: 6, setIndex: 1, type: LIBERO_RECOVERED, payload: { team: 'home', liberoNumber: 12 } }])).toBe(null)
  })
})

describe('playersForLiberoRedesignation: no way back for a libero a re-designation replaced', () => {
  it('leaves out the libero replaced before, also when his roster row lost the mark', () => {
    const roster = [{ number: 12, libero: '' }, ...[2, 3, 4, 5, 6, 7, 8, 9].map(number => ({ number, libero: '' })), { number: 10, libero: 'redesignated' }]
    const events = [{ seq: 6, setIndex: 1, type: 'libero_redesignation', payload: { team: 'home', unableLiberoNumber: 12, newLiberoNumber: 10 } }]
    const list = playersForLiberoRedesignation(roster, events, 'home', { onCourt: [2, 3, 4, 5, 6, 7], unableLiberoNumber: 10 }).map(p => p.number)
    expect(list).toEqual([8, 9])
  })
})
