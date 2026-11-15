// Owner, 15.11: each team can have a contact address that gets the final
// scoresheet, like the referees. Kept in match.officials (never public, never
// relayed) as { role: 'team contact', team, email }, without a name.
import { describe, it, expect } from 'vitest'
import { teamContactEmail, withTeamContacts, isTeamContact, cleanContactEmail, mergeOfficialsEdits } from '../officials'

const REFS = [{ role: '1st referee', firstName: 'T', lastName: 'K', email: 'r1@x.ch' }, { role: 'line judge 1', name: 'L' }]

describe('team contacts in match.officials', () => {
  it('sets, replaces and removes the two addresses, keeping the officials', () => {
    const a = withTeamContacts(REFS, { home: ' Home@Club.ch ', away: 'away@club.ch' }, cleanContactEmail)
    expect(a.filter(o => !isTeamContact(o))).toEqual(REFS)
    expect(teamContactEmail(a, 'home')).toBe('home@club.ch')
    expect(teamContactEmail(a, 'away')).toBe('away@club.ch')
    const b = withTeamContacts(a, { home: 'new@club.ch', away: '' }, cleanContactEmail)
    expect(b.filter(isTeamContact)).toEqual([{ role: 'team contact', team: 'home', email: 'new@club.ch' }])
    expect(teamContactEmail(b, 'away')).toBe('')
  })
  it('an address that does not look like one is not stored', () => {
    expect(withTeamContacts([], { home: 'not an address' }, cleanContactEmail)).toEqual([])
  })
  it('no name: never an official (the sheet, the public listing and the rosters panel skip it)', () => {
    const [c] = withTeamContacts([], { home: 'h@x.ch' }, cleanContactEmail)
    expect(c.firstName).toBeUndefined()
    expect(c.lastName).toBeUndefined()
    expect(c.name).toBeUndefined()
  })
  it('editing the officials (Edit match info) keeps the team contacts', () => {
    const withContacts = withTeamContacts(REFS, { home: 'h@x.ch' }, cleanContactEmail)
    const merged = mergeOfficialsEdits(withContacts, { ref1: { firstName: 'Thamy', lastName: 'K' } })
    expect(teamContactEmail(merged, 'home')).toBe('h@x.ch')
  })
})
