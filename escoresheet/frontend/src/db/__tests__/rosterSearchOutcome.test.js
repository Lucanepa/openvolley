import { describe, it, expect } from 'vitest'
import { offeredSentRosters, rosterSearchOutcome, sentRostersSameAsUsed } from '../gameRosters'
import { sentRosterFingerprint, takenAfter } from '../../domain/rosterVersions'

// "Search for roster" (17.11.2026): it looked only for an upload made with the
// PIN and said "No pending roster" while the team had sent theirs from the
// manager page. Now: the upload, else a sent roster, else where it looked.
// 21.11.2026 ("Check server for rosters", and the panel's own check): a
// version accepted or rejected here is not offered again, a newer one is.
const row = (extra = {}) => ({ key: '940001|home', gameNumber: '940001', side: 'home', userId: 'u1', updatedAt: 'v1', players: [], staff: [], ...extra })
const match = (extra = {}) => ({ status: 'setup', ...extra })
const upload = (ts, extra = {}) => ({
  players: [{ number: 4, firstName: 'Anna', lastName: 'Example', dob: '', libero: '', isCaptain: true, isLfp: false }],
  bench: [{ role: 'Coach', firstName: 'Hans', lastName: 'Example', dob: '' }],
  coachSignature: null,
  captainSignature: null,
  timestamp: ts,
  ...extra
})

describe('rosterSearchOutcome', () => {
  it('an upload made with the PIN wins', () => {
    expect(rosterSearchOutcome({ side: 'home', remote: upload('t1'), sentRows: [row()], match: match(), userId: 'u1' }))
      .toEqual({ kind: 'remote', changed: true, newVersion: false, sent: { row: row(), restore: false, newVersion: false } })
  })

  it('else a sent roster of this side and account', () => {
    const r = row()
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [r], match: match(), userId: 'u1' })).toEqual({ kind: 'sent', row: r, restore: false, newVersion: false })
    expect(rosterSearchOutcome({ side: 'away', remote: null, sentRows: [r], match: match(), userId: 'u1' }).kind).toBe('none')
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [r], match: match(), userId: 'u2' }).kind).toBe('none')
  })

  it('a sent roster put aside ("Not now") comes back: the search asks for it', () => {
    const r = row()
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [r], match: match({ sentRosterDismissed: { home: 'v1' } }), userId: 'u1' })).toEqual({ kind: 'sent', row: r, restore: true, newVersion: false })
  })

  it('the panel\'s own (silent) check keeps "Not now": nothing comes back by itself', () => {
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [row()], match: match({ sentRosterDismissed: { home: 'v1' } }), userId: 'u1', silent: true }))
      .toEqual({ kind: 'none', sentChecked: true, upToDate: false })
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
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [], match: match(), userId: 'u1' })).toEqual({ kind: 'none', sentChecked: true, upToDate: false })
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [], match: match(), userId: 'u1', sentChecked: false })).toEqual({ kind: 'none', sentChecked: false, upToDate: false })
  })
})

describe('rosterSearchOutcome: an upload made again', () => {
  const accepted = (ts = 't1', extra = {}) => match({ uploadedRosterTaken: takenAfter(match(), 'home', upload(ts, extra), 'accepted') })

  it('the card shows it already: nothing to store (no toast every 30 s)', () => {
    expect(rosterSearchOutcome({ side: 'home', remote: upload('t1'), match: match({ pendingHomeRoster: upload('t1') }), userId: 'u1' }))
      .toMatchObject({ kind: 'remote', changed: false })
  })

  it('a newer upload replaces the one waiting on the card', () => {
    expect(rosterSearchOutcome({ side: 'home', remote: upload('t2', { players: [] }), match: match({ pendingHomeRoster: upload('t1') }), userId: 'u1' }))
      .toMatchObject({ kind: 'remote', changed: true, newVersion: false })
  })

  it('the upload accepted here (its clear not sent yet) is not offered again', () => {
    expect(rosterSearchOutcome({ side: 'home', remote: upload('t1'), match: accepted('t1'), userId: 'u1' }))
      .toEqual({ kind: 'none', sentChecked: true, upToDate: true })
  })

  it('the same content uploaded again after Accept is not offered either (nothing would change)', () => {
    expect(rosterSearchOutcome({ side: 'home', remote: upload('t9'), match: accepted('t1'), userId: 'u1' }).kind).toBe('none')
  })

  it('a re-upload after Accept is a new version, offered as a card', () => {
    const remote = upload('t2', { players: [{ number: 5, firstName: 'Bea', lastName: 'Example', dob: '', libero: '', isCaptain: true, isLfp: false }] })
    expect(rosterSearchOutcome({ side: 'home', remote, match: accepted('t1'), userId: 'u1' }))
      .toEqual({ kind: 'remote', changed: true, newVersion: true, sent: null })
  })

  it('the upload rejected here is not offered again; one made again after it is', () => {
    const rejected = match({ uploadedRosterTaken: takenAfter(match(), 'home', upload('t1'), 'rejected') })
    expect(rosterSearchOutcome({ side: 'home', remote: upload('t1'), match: rejected, userId: 'u1' }).kind).toBe('none')
    expect(rosterSearchOutcome({ side: 'home', remote: upload('t2'), match: rejected, userId: 'u1' })).toMatchObject({ kind: 'remote', changed: true, newVersion: false })
  })

  it('an upload without a timestamp (an older app) is known by its content', () => {
    const old = upload(undefined)
    delete old.timestamp
    const m = match({ uploadedRosterTaken: takenAfter(match(), 'home', old, 'rejected') })
    expect(rosterSearchOutcome({ side: 'home', remote: { ...old }, match: m, userId: 'u1' }).kind).toBe('none')
    expect(rosterSearchOutcome({ side: 'home', remote: { ...old, players: [] }, match: m, userId: 'u1' }).kind).toBe('remote')
  })

  it('the other side\'s record does not count', () => {
    const m = match({ uploadedRosterTaken: takenAfter(match(), 'away', upload('t1'), 'accepted') })
    expect(rosterSearchOutcome({ side: 'home', remote: upload('t1'), match: m, userId: 'u1' })).toMatchObject({ kind: 'remote', changed: true, newVersion: false })
  })
})

describe('a roster sent again from the manager page', () => {
  const players = [{ number: 4, first_name: 'Anna', last_name: 'Example', license_number: '123456', is_captain: true, is_libero: false }]
  const usedV1 = (extra = {}) => match({ sentRosterUsed: { home: 'v1' }, sentRosterUsedFp: { home: sentRosterFingerprint(row({ players })) }, ...extra })

  it('a new version after the used one: offered, as a new version', () => {
    const v2 = row({ updatedAt: 'v2', players: [...players, { number: 9, first_name: 'Eva', last_name: 'Example', license_number: '234567' }] })
    expect(offeredSentRosters([v2], usedV1(), 'u1').home).toBe(v2)
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [v2], match: usedV1(), userId: 'u1' })).toEqual({ kind: 'sent', row: v2, restore: false, newVersion: true })
    expect(sentRostersSameAsUsed([v2], usedV1(), 'u1')).toEqual([])
  })

  it('sent again unchanged: not offered, recorded as used instead', () => {
    const again = row({ updatedAt: 'v2', players: [...players].reverse() })
    expect(offeredSentRosters([again], usedV1(), 'u1').home).toBeNull()
    expect(rosterSearchOutcome({ side: 'home', remote: null, sentRows: [again], match: usedV1(), userId: 'u1' })).toEqual({ kind: 'none', sentChecked: true, upToDate: true })
    expect(sentRostersSameAsUsed([again], usedV1(), 'u1')).toEqual([again])
    // the version used itself, one being told, a running match: nothing to record
    expect(sentRostersSameAsUsed([row({ players })], usedV1(), 'u1')).toEqual([])
    expect(sentRostersSameAsUsed([{ ...again, usedPending: true }], usedV1(), 'u1')).toEqual([])
    expect(sentRostersSameAsUsed([again], usedV1({ status: 'live' }), 'u1')).toEqual([])
  })

  it('unchanged but now signed ahead: a new version (the signatures come with it)', () => {
    const signed = row({ updatedAt: 'v2', players, coachSignature: 'data:image/png;base64,AAAA' })
    expect(offeredSentRosters([signed], usedV1(), 'u1').home).toBe(signed)
  })
})
