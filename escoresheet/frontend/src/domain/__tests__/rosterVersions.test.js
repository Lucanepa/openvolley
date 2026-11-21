import { describe, it, expect } from 'vitest'
import { sameUpload, sentRosterFingerprint, takenAfter, uploadedRosterFingerprint, uploadedRosterIdentity, uploadIsNewVersion, uploadState } from '../rosterVersions'

// Which version of a team's roster from the server the device has taken
// (21.11.2026: Match Setup's Remote panel checks the server by itself)
const upload = (timestamp, extra = {}) => ({
  players: [
    { number: 4, firstName: 'Anna', lastName: 'Example', dob: '', libero: '', isCaptain: true, isLfp: false },
    { number: 9, firstName: 'Eva', lastName: 'Example', dob: '123456', libero: 'libero1', isCaptain: false, isLfp: false }
  ],
  bench: [{ role: 'Coach', firstName: 'Hans', lastName: 'Example', dob: '' }],
  coachSignature: 'data:image/png;base64,AAAA',
  captainSignature: null,
  timestamp,
  ...extra
})

describe('fingerprints', () => {
  it('the same people in another order are the same roster; any change is another', () => {
    const a = upload('t1')
    const b = { ...a, players: [...a.players].reverse() }
    expect(uploadedRosterFingerprint(a)).toBe(uploadedRosterFingerprint(b))
    expect(uploadedRosterFingerprint(a)).not.toBe(uploadedRosterFingerprint({ ...a, players: [{ ...a.players[0], number: 5 }, a.players[1]] }))
    expect(uploadedRosterFingerprint(a)).not.toBe(uploadedRosterFingerprint({ ...a, coachSignature: null }))
    expect(uploadedRosterFingerprint(a)).not.toBe(uploadedRosterFingerprint({ ...a, bench: [] }))
    // the timestamp is the version, not the content
    expect(uploadedRosterFingerprint(a)).toBe(uploadedRosterFingerprint({ ...a, timestamp: 't2' }))
    expect(uploadedRosterFingerprint(null)).toBeNull()
  })

  it('a sent roster: players, officials and the signatures made ahead', () => {
    const row = { players: [{ number: 4, first_name: 'Anna', last_name: 'Example', license_number: '123456', is_captain: true }], staff: [{ role: 'Coach', first_name: 'Hans', last_name: 'Example' }] }
    expect(sentRosterFingerprint(row)).toBe(sentRosterFingerprint({ ...row, updatedAt: 'later', updatedByName: 'Someone' }))
    expect(sentRosterFingerprint(row)).not.toBe(sentRosterFingerprint({ ...row, captainSignature: 'data:image/png;base64,BBBB' }))
    expect(sentRosterFingerprint(row)).not.toBe(sentRosterFingerprint({ ...row, staff: [] }))
  })
})

describe('sameUpload / uploadState', () => {
  it('by the timestamp when both have one, else by the content', () => {
    expect(sameUpload(upload('t1'), upload('t1', { players: [] }))).toBe(true)
    expect(sameUpload(upload('t1'), upload('t2'))).toBe(false)
    const { timestamp: _t, ...old } = upload('t1')
    expect(sameUpload(old, upload('t9'))).toBe(true)
    expect(sameUpload(old, { ...old, bench: [] })).toBe(false)
    expect(sameUpload(uploadedRosterIdentity(upload('t1')), upload('t1'))).toBe(true)
    expect(sameUpload(null, upload('t1'))).toBe(false)
  })

  it('none, taken (accepted / rejected / the accepted content again), same (on the card), new', () => {
    const v1 = upload('t1')
    const v2 = upload('t2', { players: [] })
    const accepted = takenAfter(null, 'home', v1, 'accepted').home.accepted
    expect(uploadState({ remote: null })).toBe('none')
    expect(uploadState({ remote: v1 })).toBe('new')
    expect(uploadState({ remote: v1, pending: v1 })).toBe('same')
    expect(uploadState({ remote: v2, pending: v1 })).toBe('new')
    expect(uploadState({ remote: v1, taken: { accepted } })).toBe('taken')
    expect(uploadState({ remote: upload('t3'), taken: { accepted } })).toBe('taken') // the same content again
    expect(uploadState({ remote: v2, taken: { accepted } })).toBe('new')
    const rejected = takenAfter(null, 'home', v2, 'rejected').home.rejected
    expect(uploadState({ remote: v2, taken: { accepted, rejected } })).toBe('taken')
    expect(uploadState({ remote: upload('t4', { players: [] }), taken: { accepted, rejected } })).toBe('new') // made again after Reject
  })
})

describe('takenAfter / uploadIsNewVersion', () => {
  it('keeps the last accepted upload when a later one is rejected, per side', () => {
    const one = { uploadedRosterTaken: takenAfter(null, 'home', upload('t1'), 'accepted', 'A') }
    expect(uploadIsNewVersion(one, 'home')).toBe(true)
    expect(uploadIsNewVersion(one, 'away')).toBe(false)
    const two = takenAfter(one, 'home', upload('t2'), 'rejected', 'B')
    expect(two.home).toEqual({
      accepted: { version: 't1', fp: uploadedRosterFingerprint(upload('t1')), at: 'A' },
      rejected: { version: 't2', fp: uploadedRosterFingerprint(upload('t2')), at: 'B' }
    })
    expect(takenAfter({ uploadedRosterTaken: two }, 'away', upload('t3'), 'accepted', 'C').home).toEqual(two.home)
    expect(uploadIsNewVersion({}, 'home')).toBe(false)
  })
})
