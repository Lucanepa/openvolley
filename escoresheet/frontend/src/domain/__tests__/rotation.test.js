import { describe, it, expect } from 'vitest'
import { rotateLineup, getServer, getExpectedServer, isRotationValid } from '../rotation'

const LU = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }

describe('rotateLineup', () => {
  it('rotates clockwise: II->I, I->VI', () => {
    expect(rotateLineup(LU)).toEqual({ I: '2', II: '3', III: '4', IV: '5', V: '6', VI: '1' })
  })
  it('six rotations return to the start', () => {
    let lu = LU
    for (let i = 0; i < 6; i++) lu = rotateLineup(lu)
    expect(lu).toEqual(LU)
  })
  it('returns null for a missing lineup', () => {
    expect(rotateLineup(null)).toBeNull()
  })
})

describe('getServer / getExpectedServer', () => {
  it('the server is the player in position I', () => {
    expect(getServer(LU)).toBe('1')
  })
  it('expected server after N rotations', () => {
    expect(getExpectedServer(LU, 0)).toBe('1')
    expect(getExpectedServer(LU, 1)).toBe('2')
    expect(getExpectedServer(LU, 5)).toBe('6')
    expect(getExpectedServer(LU, 6)).toBe('1')
  })
})

describe('isRotationValid (serving-order Kontrolle)', () => {
  it('accepts six distinct filled positions', () => {
    expect(isRotationValid(LU)).toBe(true)
  })
  it('rejects a duplicate player (corrupted rotation)', () => {
    expect(isRotationValid({ ...LU, VI: '1' })).toBe(false)
  })
  it('rejects a missing/empty position', () => {
    expect(isRotationValid({ ...LU, IV: '' })).toBe(false)
    expect(isRotationValid({ I: '1', II: '2', III: '3', IV: '4', V: '5' })).toBe(false)
  })
  it('rejects null', () => {
    expect(isRotationValid(null)).toBe(false)
  })
})
