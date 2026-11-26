// The walkthrough's demo data (domain/walkthroughDemo): "Add from club" has
// players to tick after "Load saved team" (owner follow-up 26.11.2026, seen on
// the first-match video: every row was "In the roster")
import { describe, it, expect } from 'vitest'
import { demoClubRow, demoSavedTeamRows } from '../walkthroughDemo'

describe('walkthrough demo club', () => {
  const savedLicences = new Set(demoSavedTeamRows()[0].players.map(p => p.license_number))
  const row = demoClubRow('VBC Musterau')

  it('has players the demo saved team does not have, listed first', () => {
    const extra = row.players.filter(p => !savedLicences.has(p.sv_number))
    expect(extra.length).toBeGreaterThanOrEqual(3)
    // the picker lists the club in this order: the ones to tick come first
    expect(row.players.slice(0, extra.length)).toEqual(extra)
    // and the saved team's players are all on the list too
    for (const licence of savedLicences) expect(row.players.some(p => p.sv_number === licence)).toBe(true)
  })

  it('is the demo account\'s, for the test match\'s team only', () => {
    expect(row.userId).toBe('walkthrough-demo')
    expect(row.teamNames).toEqual(['VBC Musterau'])
    expect(row.people.filter(p => p.lists.includes('players'))).toHaveLength(row.players.length)
  })
})
