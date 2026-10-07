import { describe, it, expect } from 'vitest'
import { playerReplacedByLibero } from '../liberos'

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
