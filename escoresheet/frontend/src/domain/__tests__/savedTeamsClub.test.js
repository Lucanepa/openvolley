// "Load saved team" offers the saved teams of the club of the team being
// edited (owner 2026-11-27): the club by id from the account's club lists,
// else by the club's name as a saved team of that team keeps it; unknown: all.
// Made-up clubs and teams.
import { describe, it, expect } from 'vitest'
import { clubOfMatchTeam, savedTeamOfClub, savedTeamsOfClub } from '../savedTeams'

const team = (id, name, club, svrzTeamName = '') => ({ id, name, club, svrzTeamName, players: [] })
const SAVED = [
  team('a1', 'Seewiese H1', 'VBC Seewiese', 'VBC Seewiese 1'),
  team('a2', 'Seewiese H2', 'vbc  seewiese ', 'VBC Seewiese 2'),
  team('b1', 'Bergdorf', 'TV Bergdorf', 'TV Bergdorf'),
  team('c1', 'Talheim Damen', 'VC Talheim', ''),
  team('n1', 'Ohne Verein', '', 'Ohne Verein')
]
// the account's club lists (db/clubPlayers clubOfTeam): Seewiese's two teams
const LISTS = { 'vbc seewiese 1': 'club-see', 'vbc seewiese 2': 'club-see', 'tv bergdorf': 'club-berg' }
const clubIdOf = (name) => LISTS[String(name ?? '').trim().toLowerCase()] ?? null

describe('the club of a match team', () => {
  it('1. the account\'s club lists: id and name', () => {
    expect(clubOfMatchTeam({ teamName: 'VBC Seewiese 1', clubTeam: { clubId: 'club-see', clubName: 'VBC Seewiese' }, savedTeams: SAVED }))
      .toEqual({ id: 'club-see', name: 'VBC Seewiese' })
  })

  it('2. else the club of the saved team of that VolleyManager name, else of that name', () => {
    expect(clubOfMatchTeam({ teamName: 'tv  bergdorf', savedTeams: SAVED })).toEqual({ id: null, name: 'TV Bergdorf' })
    expect(clubOfMatchTeam({ teamName: 'Talheim Damen', savedTeams: SAVED })).toEqual({ id: null, name: 'VC Talheim' })
  })

  it('unknown: a team no list and no saved team with a club names, or no name', () => {
    expect(clubOfMatchTeam({ teamName: 'Ohne Verein', savedTeams: SAVED })).toBeNull()
    expect(clubOfMatchTeam({ teamName: 'VBC Fremd', savedTeams: SAVED })).toBeNull()
    expect(clubOfMatchTeam({ teamName: '', savedTeams: SAVED })).toBeNull()
  })
})

describe('the saved teams of a club', () => {
  it('by id where the lists know both, else by the club\'s name', () => {
    const see = { id: 'club-see', name: 'VBC Seewiese' }
    expect(savedTeamsOfClub(SAVED, see, clubIdOf).map(t => t.id)).toEqual(['a1', 'a2'])
    // the same name but another club of the lists: not of it
    const other = { id: 'club-other', name: 'TV Bergdorf' }
    expect(savedTeamOfClub(SAVED[2], other, clubIdOf)).toBe(false)
  })

  it('by the club\'s name when the club came from a saved team (case and spaces aside)', () => {
    expect(savedTeamsOfClub(SAVED, { id: null, name: 'VBC Seewiese' }, clubIdOf).map(t => t.id)).toEqual(['a1', 'a2'])
    expect(savedTeamsOfClub(SAVED, { id: null, name: 'VC Talheim' }).map(t => t.id)).toEqual(['c1'])
  })

  it('none of the club: an empty list (the picker says so in one line)', () => {
    expect(savedTeamsOfClub(SAVED, { id: 'club-x', name: 'VBC Fremd' }, clubIdOf)).toEqual([])
  })

  it('club not known: every saved team, as before', () => {
    expect(savedTeamsOfClub(SAVED, null, clubIdOf)).toHaveLength(SAVED.length)
    expect(savedTeamOfClub(SAVED[4], null)).toBe(true)
  })
})
