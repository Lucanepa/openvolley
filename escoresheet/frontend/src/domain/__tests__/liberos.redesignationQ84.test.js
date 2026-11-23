// Libero re-designation after the last libero becomes unable (FIVB 19.4.2;
// owner decision 23.11.2026, audit LOG-04). Swiss referee exam Q84: a team
// plays with L1 and L2; L1 is disqualified, then L2 is injured; the coach
// re-designates L3. Correct: "The team may not play with two liberos for the
// rest of the match". Wrong: "When libero L2 has recovered from the injury,
// he can act as a second libero alongside libero L3".
//  - the re-designation replaces the libero whose unavailability triggered it
//    (the latest to become unable among those not replaced): L2, not L1;
//  - after a re-designation no original libero of that team comes back.
import { describe, it, expect } from 'vitest'
import { liberoToReplaceByRedesignation, liberoPlayState, LIBERO_RECOVERED } from '../liberos'

const roster = () => [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(number => ({ id: number, number })),
  { id: 11, number: 11, libero: 'libero1' },
  { id: 12, number: 12, libero: 'libero2' }
]

// What Scoreboard confirmLiberoRedesignation writes: the event, the replaced
// libero's row marked 'unable', the new one's 'redesignated'
function redesignate(events, players, { seq, setIndex = 1, unable, next, reason }) {
  events.push({ id: `r${seq}`, seq, setIndex, type: 'libero_redesignation', payload: { team: 'home', unableLiberoNumber: unable, unableLiberoType: players.find(p => p.number === unable)?.libero, newLiberoNumber: next, reason } })
  return players.map(p => (p.number === unable ? { ...p, libero: 'unable' } : p.number === next ? { ...p, libero: 'redesignated' } : p))
}

// The liberos who may act now: a libero mark, not unable by the events
const acting = (players, events, setIndex) => players
  .filter(p => p.libero && p.libero !== 'unable' && !liberoPlayState(events, 'home', p.number, { setIndex, player: p }).unable)
  .map(p => p.number)

describe('Q84: L1 disqualified, L2 injured, L3 re-designated', () => {
  const start = () => [
    { id: 1, seq: 10, setIndex: 1, type: 'sanction', payload: { team: 'home', type: 'disqualification', playerType: 'libero', playerNumber: 11 } },
    { id: 2, seq: 11, setIndex: 1, type: 'libero_unable', payload: { team: 'home', liberoNumber: 11, liberoType: 'libero1', reason: 'disqualification' } },
    { id: 3, seq: 20, setIndex: 1, type: 'libero_unable', payload: { team: 'home', liberoNumber: 12, liberoType: 'libero2', reason: 'injury' } }
  ]

  it('the re-designation replaces L2, whose injury triggered it (not L1, already out)', () => {
    expect(liberoToReplaceByRedesignation(roster(), start(), 'home', { setIndex: 1 }).number).toBe(12)
  })

  it('L2 may come back only while nobody was re-designated', () => {
    expect(liberoPlayState(start(), 'home', 12, { setIndex: 2 })).toEqual({ unable: true, mayReturn: true, replaced: false })
  })

  it('after the re-designation neither original libero may return; L3 is the only libero, also after a "recovered" record', () => {
    const events = start()
    const players = redesignate(events, roster(), { seq: 21, unable: 12, next: 7, reason: 'injury' })
    for (const n of [11, 12]) {
      const state = liberoPlayState(events, 'home', n, { setIndex: 2, player: players.find(p => p.number === n) })
      expect(state.unable).toBe(true)
      expect(state.mayReturn).toBe(false)
    }
    expect(acting(players, events, 2)).toEqual([7])
    // a libero_recovered of L2 written after it (another device, an older app, a correction) changes nothing
    events.push({ id: 5, seq: 40, setIndex: 2, type: LIBERO_RECOVERED, payload: { team: 'home', liberoNumber: 12, liberoType: 'libero2' } })
    expect(liberoPlayState(events, 'home', 12, { setIndex: 2, player: players.find(p => p.number === 12) })).toMatchObject({ unable: true, mayReturn: false })
    expect(acting(players, events, 2)).toEqual([7])
  })

  it('the same when the re-designation was recorded against L1 (the old ranking): L2 stays out', () => {
    const events = start()
    const players = redesignate(events, roster(), { seq: 21, unable: 11, next: 7, reason: 'injury' })
    const l2 = players.find(p => p.number === 12)
    expect(liberoPlayState(events, 'home', 12, { setIndex: 2, player: l2 })).toEqual({ unable: true, mayReturn: false, replaced: false })
    events.push({ id: 5, seq: 40, setIndex: 2, type: LIBERO_RECOVERED, payload: { team: 'home', liberoNumber: 12, liberoType: 'libero2' } })
    expect(acting(players, events, 2)).toEqual([7])
  })

  it('L1 declared unable, L2 injured: the re-designation replaces L2 too', () => {
    const events = [
      { id: 1, seq: 10, setIndex: 1, type: 'libero_unable', payload: { team: 'home', liberoNumber: 11, liberoType: 'libero1', reason: 'declared' } },
      { id: 2, seq: 20, setIndex: 1, type: 'libero_unable', payload: { team: 'home', liberoNumber: 12, liberoType: 'libero2', reason: 'injury' } }
    ]
    expect(liberoToReplaceByRedesignation(roster(), events, 'home', { setIndex: 1 }).number).toBe(12)
  })
})

describe('after a re-designation', () => {
  it('a libero back before it stays a libero (his return counts); the re-designated one injured later may come back', () => {
    // one libero #12: injured, back, injured again, then #7 re-designated
    const events = [
      { seq: 5, setIndex: 1, type: 'libero_unable', payload: { team: 'home', liberoNumber: 12, reason: 'injury' } },
      { seq: 6, setIndex: 1, type: LIBERO_RECOVERED, payload: { team: 'home', liberoNumber: 12 } },
      { seq: 9, setIndex: 1, type: 'libero_unable', payload: { team: 'home', liberoNumber: 12, reason: 'injury' } },
      { seq: 10, setIndex: 1, type: 'libero_redesignation', payload: { team: 'home', unableLiberoNumber: 12, newLiberoNumber: 7, reason: 'injury' } },
      // #7 injured: he may come back (no further re-designation replaced him)
      { seq: 20, setIndex: 2, type: 'libero_unable', payload: { team: 'home', liberoNumber: 7, reason: 'injury' } }
    ]
    expect(liberoPlayState(events, 'home', 12, { setIndex: 2 })).toMatchObject({ unable: true, mayReturn: false, replaced: true })
    expect(liberoPlayState(events, 'home', 7, { setIndex: 2 })).toEqual({ unable: true, mayReturn: true, replaced: false })
    events.push({ seq: 21, setIndex: 2, type: LIBERO_RECOVERED, payload: { team: 'home', liberoNumber: 7 } })
    expect(liberoPlayState(events, 'home', 7, { setIndex: 2 }).unable).toBe(false)
  })

  it('a second re-designation replaces the re-designated libero who became unable last, not the disqualified L1', () => {
    const players = [...roster().map(p => (p.number === 12 ? { ...p, libero: 'unable' } : p.number === 7 ? { ...p, libero: 'redesignated' } : p))]
    const events = [
      { seq: 10, setIndex: 1, type: 'sanction', payload: { team: 'home', type: 'disqualification', playerType: 'libero', playerNumber: 11 } },
      { seq: 11, setIndex: 1, type: 'libero_unable', payload: { team: 'home', liberoNumber: 11, reason: 'disqualification' } },
      { seq: 20, setIndex: 1, type: 'libero_unable', payload: { team: 'home', liberoNumber: 12, reason: 'injury' } },
      { seq: 21, setIndex: 1, type: 'libero_redesignation', payload: { team: 'home', unableLiberoNumber: 12, newLiberoNumber: 7, reason: 'injury' } },
      { seq: 30, setIndex: 2, type: 'libero_unable', payload: { team: 'home', liberoNumber: 7, reason: 'injury' } }
    ]
    expect(liberoToReplaceByRedesignation(players, events, 'home', { setIndex: 2 }).number).toBe(7)
  })

  it('the other team\'s re-designation changes nothing for this team', () => {
    const events = [
      { seq: 5, setIndex: 1, type: 'libero_unable', payload: { team: 'home', liberoNumber: 12, reason: 'injury' } },
      { seq: 6, setIndex: 1, type: 'libero_redesignation', payload: { team: 'away', unableLiberoNumber: 12, newLiberoNumber: 7, reason: 'injury' } }
    ]
    expect(liberoPlayState(events, 'home', 12, { setIndex: 1 })).toEqual({ unable: true, mayReturn: true, replaced: false })
  })
})
