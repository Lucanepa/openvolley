import { describe, it, expect } from 'vitest'
import { isStaleClosedCopy } from '../matchReopen'

// 2026-10-23: a phone kept a 'live' copy of a match the server had closed and
// reopened it on its scoring screen at every start. Such a copy is told apart
// from the local evidence alone (offline too).
describe('isStaleClosedCopy', () => {
  const closed = { code: 'OV_MATCH_CLOSED' }

  it('a copy still scored here whose match the server closed', () => {
    expect(isStaleClosedCopy({ status: 'live', cloudBlock: closed })).toBe(true)
    expect(isStaleClosedCopy({ status: 'scheduled', closed_at: '2026-10-20T19:09:00Z' })).toBe(true)
    expect(isStaleClosedCopy({ cloudBlock: closed })).toBe(true)
  })

  it('not a copy without a closed sign, or blocked for another reason', () => {
    expect(isStaleClosedCopy({ status: 'live' })).toBe(false)
    expect(isStaleClosedCopy({ status: 'live', cloudBlock: { code: 'OV_GAME_TAKEN' } })).toBe(false)
  })

  it('not a copy that ended, was approved or is final here: Match End shows those', () => {
    for (const status of ['ended', 'approved', 'final']) {
      expect(isStaleClosedCopy({ status, cloudBlock: closed })).toBe(false)
      expect(isStaleClosedCopy({ status, closed_at: '2026-10-20T19:09:00Z' })).toBe(false)
    }
  })

  it('never a test match, a match another device took over, or no match', () => {
    expect(isStaleClosedCopy({ status: 'live', test: true, cloudBlock: closed })).toBe(false)
    expect(isStaleClosedCopy({ status: 'live', cloudBlock: { code: 'OV_SCORER_MOVED', closed: true } })).toBe(false)
    expect(isStaleClosedCopy({ status: 'live', closed_at: '2026-10-20T19:09:00Z', cloudBlock: { code: 'OV_SCORER_MOVED', closed: true } })).toBe(false)
    expect(isStaleClosedCopy(null)).toBe(false)
    expect(isStaleClosedCopy(undefined)).toBe(false)
  })
})
