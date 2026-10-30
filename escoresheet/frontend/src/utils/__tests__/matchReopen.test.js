import { describe, it, expect } from 'vitest'
import { isContinuedElsewhere, isStaleClosedCopy, serverRowClosed } from '../matchReopen'

// The server's row of a match (Match End's reopen check, the self-check on
// open): closed as the backend refuses writes (db/007, closed_at)
describe('serverRowClosed', () => {
  it('closed_at decides when the row carries it', () => {
    expect(serverRowClosed({ status: 'final', closed_at: '2026-10-20T18:40:00Z' })).toBe(true)
    expect(serverRowClosed({ status: 'approved', closed_at: '2026-10-20T18:40:00Z' })).toBe(true)
    // an admin reopened it: closed_at cleared
    expect(serverRowClosed({ status: 'ended', closed_at: null })).toBe(false)
    expect(serverRowClosed({ status: 'live', closed_at: null })).toBe(false)
  })

  it('without the column (another account\'s match, the public columns): approved / final', () => {
    expect(serverRowClosed({ status: 'approved' })).toBe(true)
    expect(serverRowClosed({ status: 'final' })).toBe(true)
    expect(serverRowClosed({ status: 'ended' })).toBe(false)
  })

  it('no row: nothing is closed there', () => {
    expect(serverRowClosed(null)).toBe(false)
    expect(serverRowClosed(undefined)).toBe(false)
  })
})

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

// 2026-10-29: the desktop app reopened its copy of match 406970, continued
// and closed on a phone a week before, and wrote a fresh backup file of it.
// No backup file of such a copy; the final state of a match this device
// ended or approved is always backed up.
describe('isContinuedElsewhere', () => {
  const closed = { code: 'OV_MATCH_CLOSED' }
  const moved = { code: 'OV_SCORER_MOVED' }

  it('a copy the server closed while it was scored here, or one another device took over', () => {
    expect(isContinuedElsewhere({ status: 'live', cloudBlock: closed })).toBe(true)
    expect(isContinuedElsewhere({ status: 'scheduled', closed_at: '2026-10-20T19:09:00Z' })).toBe(true)
    expect(isContinuedElsewhere({ status: 'live', cloudBlock: moved })).toBe(true)
    // taken over and closed there (markScorerMoved makes the copy final)
    expect(isContinuedElsewhere({ status: 'final', cloudBlock: { ...moved, closed: true } })).toBe(true)
  })

  it('never a copy this device ended or approved, whatever the server says', () => {
    expect(isContinuedElsewhere({ status: 'ended', approved: true, cloudBlock: closed })).toBe(false)
    expect(isContinuedElsewhere({ status: 'ended', approved: true })).toBe(false)
    expect(isContinuedElsewhere({ status: 'ended', cloudBlock: moved })).toBe(false)
    expect(isContinuedElsewhere({ status: 'ended', closed_at: '2026-10-20T19:09:00Z' })).toBe(false)
    // ended here, then closed on the server (useSyncQueue closesLocalCopy)
    expect(isContinuedElsewhere({ status: 'final', cloudBlock: closed })).toBe(false)
  })

  it('not an open copy, a test match or no match', () => {
    expect(isContinuedElsewhere({ status: 'live' })).toBe(false)
    expect(isContinuedElsewhere({ status: 'live', cloudBlock: { code: 'OV_GAME_TAKEN' } })).toBe(false)
    expect(isContinuedElsewhere({ status: 'live', test: true, cloudBlock: closed })).toBe(false)
    expect(isContinuedElsewhere({ status: 'live', test: true, cloudBlock: moved })).toBe(false)
    expect(isContinuedElsewhere(null)).toBe(false)
  })
})
