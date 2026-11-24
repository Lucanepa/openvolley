import { describe, it, expect } from 'vitest'
import { pinsForRestore } from '../backupManager'

const file = (match, unlockedWith) => ({ secretsRemoved: true, match, unlockedWith })

describe('pinsForRestore', () => {
  it('a file opened with the referee PIN gets a game PIN of its own, marked as made up', () => {
    const pins = pinsForRestore(file({ seed_key: 's' }, { pin: 'referee', field: 'refereePin', value: '4321' }), null)
    expect(pins.refereePin).toBe('4321')
    expect(pins.gamePin).toMatch(/^\d{6}$/)
    expect(pins.gamePinGenerated).toBe(true)
    expect({ ...pins }.gamePinGenerated).toBeUndefined() // spreading does not carry it
  })

  it('a file opened with the game PIN keeps that PIN: not made up', () => {
    const pins = pinsForRestore(file({ seed_key: 's' }, { pin: 'game', field: 'gamePin', value: '123456' }), null)
    expect(pins.gamePin).toBe('123456')
    expect(pins.gamePinGenerated).toBeUndefined()
  })

  it('the replaced copy keeps its game PIN, a test match gets none', () => {
    expect(pinsForRestore(file({}), { gamePin: '999999' }).gamePin).toBe('999999')
    expect(pinsForRestore(file({ test: true }), null).gamePin).toBeUndefined()
  })
})
