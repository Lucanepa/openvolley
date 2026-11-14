import { describe, it, expect } from 'vitest'
import { rosterSignatureKey, staleSignatureFields, signaturesClearedRemark, signatureReplacedRemark } from '../rosterSignatures'

const roster = [
  { number: 4, lastName: 'Alpha', firstName: 'A', dob: '01.01.2000', libero: '', isCaptain: true },
  { number: 9, lastName: 'Bravo', firstName: 'B', dob: '02.02.2001', libero: 'libero1' }
]
const bench = [{ role: 'Coach', firstName: 'Cora', lastName: 'Coach', dob: '' }, { role: 'Assistant coach 1', firstName: '', lastName: '', dob: '' }]

describe('rosterSignatureKey', () => {
  it('ignores row order and empty bench rows', () => {
    expect(rosterSignatureKey([...roster].reverse(), bench.slice(0, 1))).toBe(rosterSignatureKey(roster, bench))
  })
  it('changes with a number, a libero, the captain or a bench official', () => {
    const base = rosterSignatureKey(roster, bench)
    expect(rosterSignatureKey([{ ...roster[0], number: 14 }, roster[1]], bench)).not.toBe(base)
    expect(rosterSignatureKey([roster[0], { ...roster[1], libero: '' }], bench)).not.toBe(base)
    expect(rosterSignatureKey([{ ...roster[0], isCaptain: false }, roster[1]], bench)).not.toBe(base)
    expect(rosterSignatureKey(roster, [{ ...bench[0], lastName: 'Other' }])).not.toBe(base)
  })
})

describe('staleSignatureFields', () => {
  const fields = ['homeCoachSignature', 'homeCaptainSignature']
  const images = { homeCoachSignature: 'data:c', homeCaptainSignature: 'data:k' }
  it('a signature from before the editor goes when the roster changed', () => {
    expect(staleSignatureFields(images, fields, {}, 'opened', 'changed')).toEqual(fields)
    expect(staleSignatureFields(images, fields, {}, 'same', 'same')).toEqual([])
  })
  it('a signature given for the roster being saved stays', () => {
    expect(staleSignatureFields(images, fields, { homeCoachSignature: 'changed' }, 'opened', 'changed')).toEqual(['homeCaptainSignature'])
  })
  it('a missing signature is never stale', () => {
    expect(staleSignatureFields({ homeCoachSignature: null }, fields, {}, 'a', 'b')).toEqual([])
  })
})

describe('remarks', () => {
  const at = new Date('2026-11-20T17:05:00Z')
  it('names the team, the roles and the time', () => {
    expect(signaturesClearedRemark({ team: 'Team V', roles: ['captain', 'coach'], at }))
      .toBe('Roster of Team V changed after signing (18:05): Captain and Coach signatures removed, to be signed again')
    expect(signaturesClearedRemark({ team: 'Team V', roles: ['coach'], at })).toMatch(/: Coach signature removed/)
    expect(signatureReplacedRemark({ team: 'Team V', role: 'captain', at })).toBe('Captain signature of Team V replaced (re-signed 18:05)')
  })
})
