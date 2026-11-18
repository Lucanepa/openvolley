import { describe, it, expect } from 'vitest'
import { rosterSearchOutcome } from '../gameRosters'

// "Search for roster" (17.11.2026): it looked only for an upload made with the
// PIN and said "No pending roster" while the team had sent theirs from the
// manager page. Now: the upload, else a sent roster, else where it looked.
const row = (extra = {}) => ({ key: '940001|home', gameNumber: '940001', side: 'home', userId: 'u1', updatedAt: 'v1', players: [], staff: [], ...extra })
const match = (extra = {}) => ({ status: 'setup', ...extra })

describe('rosterSearchOutcome', () => {
  it('an upload made with the PIN wins', () => {
    expect(rosterSearchOutcome({ side: 'home', remote: { players: [] }, sentRows: [row()], match: match(), userId: 'u1' })).toEqual({ kind: 'remote' })
  })

  it('else a sent roster of this side and account', () => {
    const r = row()
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [r], match: match(), userId: 'u1' })).toEqual({ kind: 'sent', row: r, restore: false })
    expect(rosterSearchOutcome({ side: 'away', remote: null, sentRows: [r], match: match(), userId: 'u1' }).kind).toBe('none')
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [r], match: match(), userId: 'u2' }).kind).toBe('none')
  })

  it('a sent roster put aside ("Not now") comes back: the search asks for it', () => {
    const r = row()
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [r], match: match({ sentRosterDismissed: { home: 'v1' } }), userId: 'u1' })).toEqual({ kind: 'sent', row: r, restore: true })
  })

  it('one used (accepted) never does, nor one of a running or test match', () => {
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [row()], match: match({ sentRosterUsed: { home: 'v1' } }), userId: 'u1' }).kind).toBe('none')
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [row({ usedPending: true })], match: match({ sentRosterDismissed: { home: 'v1' } }), userId: 'u1' }).kind).toBe('none')
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [row()], match: match({ status: 'live' }), userId: 'u1' }).kind).toBe('none')
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [row()], match: match({ test: true }), userId: 'u1' }).kind).toBe('none')
  })

  it('the upload could not be asked: a sent roster still shows (offline first), else an error', () => {
    const r = row()
    expect(rosterSearchOutcome({ side: 'home', remote: null, remoteFailed: true, sentRows: [r], match: match(), userId: 'u1' }).kind).toBe('sent')
    expect(rosterSearchOutcome({ side: 'home', remote: null, remoteFailed: true, sentRows: [], match: match(), userId: 'u1' })).toEqual({ kind: 'error' })
  })

  it('nothing anywhere: says whether sent rosters were looked at', () => {
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [], match: match(), userId: 'u1' })).toEqual({ kind: 'none', sentChecked: true })
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [], match: match(), userId: 'u1', sentChecked: false })).toEqual({ kind: 'none', sentChecked: false })
  })
})
