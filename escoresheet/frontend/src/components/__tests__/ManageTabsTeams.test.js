import { describe, it, expect } from 'vitest'
import { manageTabsFor } from '../manage/ManageConsole'
import { accessFromRoles } from '../../lib/access'

describe('manageTabsFor: My teams (db/023)', () => {
  it('shows My teams to an account that acts for a team, whatever its roles', () => {
    const teamManager = { ...accessFromRoles([]), managedClubs: [], managedTeams: [{ id: 't1', name: 'KSC Wiedikon H1' }] }
    expect(manageTabsFor(teamManager)).toEqual(['myteams'])
    const clubManager = { ...accessFromRoles(['scorer']), managedClubs: [{ id: 'c1' }], managedTeams: [{ id: 't1' }] }
    expect(manageTabsFor(clubManager)).toEqual(['myclub', 'myteams'])
    expect(manageTabsFor({ ...accessFromRoles(['scorer']), managedClubs: [], managedTeams: [] })).toEqual([])
  })

  it('leaves it out of the OpenBeach console', () => {
    const teamManager = { ...accessFromRoles([]), managedTeams: [{ id: 't1' }] }
    expect(manageTabsFor(teamManager, { app: 'beach', tabs: ['accounts', 'invites', 'scoresheets', 'audit', 'activity', 'teams', 'tournaments'] })).toEqual([])
  })
})
