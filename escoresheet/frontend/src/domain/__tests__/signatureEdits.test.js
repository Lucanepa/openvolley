import { describe, it, expect } from 'vitest'
import { pinApprovalState, PIN_APPROVAL_REASONS } from '../accountApproval'
import { signatureEditLocked, signaturesPayload, signaturesSyncJob, POST_MATCH_SIGNATURE_KEYS } from '../signatureEdits'
import { POST_MATCH_SIGNATURE_FIELDS } from '../matchEnd'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

const SETS = [
  { index: 1, homePoints: 25, awayPoints: 20, finished: true },
  { index: 2, homePoints: 25, awayPoints: 18, finished: true },
  { index: 3, homePoints: 25, awayPoints: 22, finished: true }
]
const KEY = 'ov-result-v1|1:25:20,2:25:18,3:25:22'
const valid = { id: 'a', slot: 'referee1', result_key: KEY }
const stale = { id: 'b', slot: 'referee1', result_key: 'ov-result-v1|1:25:20' }
// Everything in place: the scoring table may offer "Approve with PIN"
const ready = { sets: SETS, hasSeedKey: true, cloudApi: true, feature: 'available', signedIn: true, callerMayApprove: true, online: true }

describe('pinApprovalState: never silently nothing', () => {
  it('offers the PIN on scorer, 2nd and 1st referee when everything is in place', () => {
    for (const role of ['scorer', 'ref2', 'ref1']) expect(pinApprovalState({ ...ready, role })).toEqual({ state: 'offer' })
  })

  it('the assistant scorer signs only (owner rule); the captains have no line', () => {
    expect(pinApprovalState({ ...ready, role: 'asst-scorer' })).toEqual({ state: 'unavailable', reason: 'signOnly' })
    expect(pinApprovalState({ ...ready, role: 'captain-a' })).toBeNull()
    expect(pinApprovalState({ ...ready, role: 'captain-b' })).toBeNull()
  })

  it('a valid approval reads approved whatever else holds (offline, signed out, locked)', () => {
    expect(pinApprovalState({ role: 'ref1', approval: valid, sets: SETS, online: false, locked: true })).toEqual({ state: 'approved' })
  })

  it('a stale approval is offered again', () => {
    expect(pinApprovalState({ ...ready, role: 'ref1', approval: stale })).toEqual({ state: 'offer' })
  })

  it('names the first thing to fix, in order', () => {
    const cases = [
      [{ locked: true }, 'locked'],
      [{ isBeach: true }, 'beach'],
      [{ hasSeedKey: false }, 'localMatch'],
      [{ cloudApi: false }, 'noCloud'],
      [{ feature: 'unavailable' }, 'serverOff'],
      [{ signedIn: false }, 'signedOut'],
      [{ callerMayApprove: false }, 'callerRole'],
      [{ online: false }, 'offline']
    ]
    for (const [over, reason] of cases) {
      expect(pinApprovalState({ ...ready, role: 'scorer', ...over })).toEqual({ state: 'unavailable', reason })
    }
    // several at once: the earliest wins (a desktop window off the cloud, signed out, offline)
    expect(pinApprovalState({ ...ready, role: 'ref2', cloudApi: false, signedIn: false, online: false }).reason).toBe('noCloud')
    // the feature is assumed on until the server says otherwise
    expect(pinApprovalState({ ...ready, role: 'ref2', feature: 'unknown' })).toEqual({ state: 'offer' })
  })

  it('every reason has a line in all five locales', () => {
    for (const [name, locale] of Object.entries({ en, de, deCH, fr, it_ })) {
      expect(typeof locale.approval.approveWithPin, `${name} approveWithPin`).toBe('string')
      for (const reason of PIN_APPROVAL_REASONS) {
        expect(typeof locale.approval.why[reason], `${name} approval.why.${reason}`).toBe('string')
      }
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
      asst_scorer: null, scorer: 'data:s', ref2: null, ref1: 'data:r1'
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
