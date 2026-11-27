import { describe, it, expect } from 'vitest'
import { signatureEditLocked, signaturesPayload, signaturesSyncJob, POST_MATCH_SIGNATURE_KEYS, optionalSignatureSlots } from '../signatureEdits'
import { POST_MATCH_SIGNATURE_FIELDS } from '../matchEnd'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

describe('optionalSignatureSlots', () => {
  it('a slot for a named official or one already signed; a null field is no official', () => {
    expect(optionalSignatureSlots({ officials: [] })).toEqual({ asstScorer: false, ref2: false })
    expect(optionalSignatureSlots({ ref2Signature: 'data:x', asstScorerSignature: null })).toEqual({ asstScorer: false, ref2: true })
  })
})

describe('the signature texts', () => {
  it('every one has a line in all five locales', () => {
    for (const [name, locale] of Object.entries({ en, de, deCH, fr, it_ })) {
      for (const k of ['resign', 'clearSignature', 'signatureLocked', 'signatureSaveFailed']) {
        expect(typeof locale.matchEnd[k], `${name} matchEnd.${k}`).toBe('string')
      }
    }
  })
})

describe('signatureEditLocked', () => {
  it('open while the match is ended and not approved', () => {
    expect(signatureEditLocked({ status: 'ended', approved: false })).toBe(false)
    expect(signatureEditLocked({ status: 'ended' })).toBe(false)
  })
  it('locked once approved (local flag or state), final or closed', () => {
    expect(signatureEditLocked({ status: 'ended' }, { isApproved: true })).toBe(true)
    expect(signatureEditLocked({ status: 'ended', approved: true })).toBe(true)
    expect(signatureEditLocked({ status: 'approved' })).toBe(true)
    expect(signatureEditLocked({ status: 'final' })).toBe(true)
    expect(signatureEditLocked({ status: 'ended', closed_at: '2026-10-07T20:00:00Z' })).toBe(true)
  })
})

describe('signaturesPayload / signaturesSyncJob', () => {
  const match = {
    seed_key: 'match_1', test: false,
    homeCoachSignature: 'data:hc', homeCaptainSignature: 'data:hk', awayCoachSignature: 'data:ac', awayCaptainSignature: null,
    homePostGameCaptainSignature: 'data:pa', awayPostGameCaptainSignature: 'data:pb',
    scorerSignature: 'data:s', ref2Signature: null, ref1Signature: 'data:r1'
  }

  it('carries the pre-match signatures too: the server replaces the whole column', () => {
    expect(signaturesPayload(match)).toEqual({
      home_coach: 'data:hc', home_captain: 'data:hk', away_coach: 'data:ac', away_captain: '',
      home_captain_post_game: 'data:pa', away_captain_post_game: 'data:pb',
      asst_scorer: null, scorer: 'data:s', ref2: null, ref1: 'data:r1', remarks: null
    })
  })

  it('maps every post-match field of the reopen list', () => {
    expect(Object.keys(POST_MATCH_SIGNATURE_KEYS).sort()).toEqual([...POST_MATCH_SIGNATURE_FIELDS].sort())
  })

  it('a match update job for a synced official match only', () => {
    const job = signaturesSyncJob(match, new Date('2026-10-07T20:00:00Z'))
    expect(job).toEqual({
      resource: 'match', action: 'update', status: 'queued', ts: '2026-10-07T20:00:00.000Z',
      payload: { id: 'match_1', signatures: signaturesPayload(match) }
    })
    expect(signaturesSyncJob({ ...match, test: true })).toBeNull()
    expect(signaturesSyncJob({ ...match, seed_key: null })).toBeNull()
    expect(signaturesSyncJob(null)).toBeNull()
  })

  it('a cleared signature goes up as null', () => {
    expect(signaturesSyncJob({ ...match, scorerSignature: null }).payload.signatures.scorer).toBeNull()
  })
})
