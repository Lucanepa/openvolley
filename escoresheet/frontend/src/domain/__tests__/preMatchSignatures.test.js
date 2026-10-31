import { describe, it, expect } from 'vitest'
import { needsPreMatchSignatures, missingRolesOf, missingPreMatchSignatures, beforeFirstServe, PRE_MATCH_ROLES } from '../preMatchSignatures'

const INK = 'data:image/png;base64,AAAA'
const allSigned = {
  homeCoachSignature: INK,
  homeCaptainSignature: INK,
  awayCoachSignature: INK,
  awayCaptainSignature: INK
}

describe('needsPreMatchSignatures', () => {
  it('an official match needs them, a test match and an easy match do not', () => {
    expect(needsPreMatchSignatures({ test: false })).toBe(true)
    expect(needsPreMatchSignatures({})).toBe(true)
    expect(needsPreMatchSignatures({ test: true })).toBe(false)
    expect(needsPreMatchSignatures({ easy: true })).toBe(false)
    expect(needsPreMatchSignatures(null)).toBe(false)
    expect(needsPreMatchSignatures(undefined)).toBe(false)
  })
})

describe('missingRolesOf', () => {
  it('lists the coach and the captain until each has signed', () => {
    expect(PRE_MATCH_ROLES).toEqual(['coach', 'captain'])
    expect(missingRolesOf({}, 'home')).toEqual(['coach', 'captain'])
    expect(missingRolesOf({ homeCoachSignature: INK }, 'home')).toEqual(['captain'])
    expect(missingRolesOf({ homeCaptainSignature: INK }, 'home')).toEqual(['coach'])
    expect(missingRolesOf({ homeCoachSignature: INK, homeCaptainSignature: INK }, 'home')).toEqual([])
  })

  it('reads only its own team', () => {
    expect(missingRolesOf({ homeCoachSignature: INK, homeCaptainSignature: INK }, 'away')).toEqual(['coach', 'captain'])
  })

  it('an empty or cleared signature is missing', () => {
    expect(missingRolesOf({ awayCoachSignature: '', awayCaptainSignature: null }, 'away')).toEqual(['coach', 'captain'])
  })
})

describe('missingPreMatchSignatures', () => {
  it('null once all four have signed', () => {
    expect(missingPreMatchSignatures(allSigned)).toBeNull()
  })

  it('per team what is still to sign', () => {
    expect(missingPreMatchSignatures({})).toEqual({ home: ['coach', 'captain'], away: ['coach', 'captain'] })
    expect(missingPreMatchSignatures({ ...allSigned, awayCaptainSignature: null })).toEqual({ home: [], away: ['captain'] })
  })

  it('null for a test match or an easy match, signed or not', () => {
    expect(missingPreMatchSignatures({ test: true })).toBeNull()
    expect(missingPreMatchSignatures({ easy: true })).toBeNull()
  })
})

describe('beforeFirstServe', () => {
  it('only set 1 before its first point', () => {
    expect(beforeFirstServe({ setIndex: 1, isFirstRally: true })).toBe(true)
    expect(beforeFirstServe({ setIndex: 1, isFirstRally: false })).toBe(false)
    expect(beforeFirstServe({ setIndex: 2, isFirstRally: true })).toBe(false)
    expect(beforeFirstServe({ setIndex: undefined, isFirstRally: true })).toBe(false)
  })
})
