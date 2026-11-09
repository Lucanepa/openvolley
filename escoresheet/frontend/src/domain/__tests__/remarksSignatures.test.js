import { describe, it, expect } from 'vitest'
import { MAX_REMARKS_SIGNATURES, remarksSignatureCaption, remarksSignaturesOf, withRemarksSignature, withoutRemarksSignature } from '../remarksSignatures'
import { postMatchSignaturesFromServer, signaturesPayload } from '../signatureEdits'

// A referee coach (or another official without a box) signs in the REMARKS
// (SVRZ feedback 2026-11-09)
const INK = 'data:image/png;base64,AAAA'
const NOW = new Date('2026-11-09T18:00:00Z')

describe('signatures in the remarks', () => {
  it('adds a signature with its role, name and time', () => {
    expect(withRemarksSignature(null, { role: ' Referee coach ', name: 'Anna  Muster', image: INK }, NOW))
      .toEqual([{ role: 'Referee coach', name: 'Anna Muster', image: INK, signedAt: '2026-11-09T18:00:00.000Z' }])
  })

  it('needs a role and an image; the name is optional', () => {
    expect(withRemarksSignature([], { role: '', name: 'Anna', image: INK })).toBeNull()
    expect(withRemarksSignature([], { role: 'Supervisor', name: '', image: null })).toBeNull()
    expect(withRemarksSignature([], { role: 'Supervisor', name: '', image: INK }, NOW)[0].name).toBe('')
  })

  it(`takes at most ${MAX_REMARKS_SIGNATURES}`, () => {
    let list = []
    for (let i = 0; i < MAX_REMARKS_SIGNATURES; i++) list = withRemarksSignature(list, { role: `R${i}`, name: '', image: INK }, NOW)
    expect(list).toHaveLength(MAX_REMARKS_SIGNATURES)
    expect(withRemarksSignature(list, { role: 'One more', name: '', image: INK })).toBeNull()
  })

  it('removes one by its place', () => {
    const list = [{ role: 'A', name: '', image: INK }, { role: 'B', name: '', image: INK }]
    expect(withoutRemarksSignature(list, 0).map(s => s.role)).toEqual(['B'])
  })

  it('keeps only valid entries of a stored or received list', () => {
    expect(remarksSignaturesOf('x')).toEqual([])
    expect(remarksSignaturesOf([{ role: 'RC', image: 'javascript:alert(1)' }, { role: '', image: INK }, null, { role: 'RC', name: 'Anna', image: INK }]))
      .toEqual([{ role: 'RC', name: 'Anna', image: INK, signedAt: null }])
  })

  it('caption: role · name, or the role alone', () => {
    expect(remarksSignatureCaption({ role: 'Referee coach', name: 'Anna Muster' })).toBe('Referee coach · Anna Muster')
    expect(remarksSignatureCaption({ role: 'Supervisor', name: '' })).toBe('Supervisor')
  })

  it('travels in the match signatures as `remarks` and comes back from the server', () => {
    const list = withRemarksSignature(null, { role: 'Referee coach', name: 'Anna', image: INK }, NOW)
    expect(signaturesPayload({ remarksSignatures: list }).remarks).toEqual(list)
    expect(signaturesPayload({}).remarks).toBeNull()
    expect(postMatchSignaturesFromServer({ remarks: list }).remarksSignatures).toEqual(list)
    expect(postMatchSignaturesFromServer({}).remarksSignatures).toBeNull()
  })
})
