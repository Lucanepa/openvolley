// A short name or a shirt colour changed after the coin toss (Edit match
// info) must reach the live state the referee and bench tablets, the
// livescore and Point Hub read (team_a_short / team_a_color): the scoring
// screen builds it from the match row first, so the editor writes the match
// row's mirror fields too.
import { describe, it, expect } from 'vitest'
import { cleanShortName, liveTeamIdentity, teamMirrorPatch } from '../teamIdentity'

const homeTeam = { id: 1, name: 'Home VC', shortName: 'HOM', color: '#ef4444' }
const awayTeam = { id: 2, name: 'Away VC', shortName: 'AWY', color: '#3b82f6' }
const match = { homeTeamId: 1, awayTeamId: 2, coinTossTeamA: 'away', homeName: 'Home VC', awayName: 'Away VC', homeShortName: 'HOM', awayShortName: 'AWY', homeColor: '#ef4444', awayColor: '#3b82f6' }

describe('teamMirrorPatch', () => {
  it('writes only the fields that changed', () => {
    expect(teamMirrorPatch({ home: homeTeam, away: awayTeam }, { home: { ...homeTeam, shortName: 'NEW' }, away: { ...awayTeam, color: '#1d4ed8' } }))
      .toEqual({ homeShortName: 'NEW', awayColor: '#1d4ed8' })
  })

  it('nothing changed: nothing written (a match row with server names keeps them)', () => {
    expect(teamMirrorPatch({ home: homeTeam, away: awayTeam }, { home: { ...homeTeam }, away: { ...awayTeam } })).toEqual({})
  })

  it('a name edited at the match end goes to the match row too', () => {
    expect(teamMirrorPatch({ home: homeTeam }, { home: { ...homeTeam, name: 'Home VC 2' } })).toEqual({ homeName: 'Home VC 2' })
  })
})

describe('liveTeamIdentity', () => {
  it('team A is the coin toss winner, with its short name and colour', () => {
    expect(liveTeamIdentity(match, homeTeam, awayTeam)).toEqual({
      teamAKey: 'away',
      teamAName: 'Away VC', teamAShort: 'AWY', teamAColor: '#3b82f6',
      teamBName: 'Home VC', teamBShort: 'HOM', teamBColor: '#ef4444'
    })
  })

  it('an edit after the coin toss reaches team_a_short / team_b_color', () => {
    const before = { home: homeTeam, away: awayTeam }
    const after = { home: { ...homeTeam, shortName: 'NEWH', color: '#22c55e' }, away: { ...awayTeam, shortName: 'NEWA' } }
    const edited = { ...match, ...teamMirrorPatch(before, after) }
    const live = liveTeamIdentity(edited, after.home, after.away)
    expect(live).toMatchObject({ teamAShort: 'NEWA', teamAColor: '#3b82f6', teamBShort: 'NEWH', teamBColor: '#22c55e' })
  })

  it('the team record alone (the old editor wrote only it) did not move the short name; the mirror does', () => {
    const teamOnly = liveTeamIdentity(match, { ...homeTeam, shortName: 'NEWH' }, awayTeam)
    expect(teamOnly.teamBShort).toBe('HOM')
    const mirrored = liveTeamIdentity({ ...match, homeShortName: 'NEWH' }, { ...homeTeam, shortName: 'NEWH' }, awayTeam)
    expect(mirrored.teamBShort).toBe('NEWH')
  })

  it('no short name on the match: the team record\'s, else the first three letters', () => {
    const bare = { coinTossTeamA: 'home' }
    expect(liveTeamIdentity(bare, homeTeam, { name: 'Away VC' })).toMatchObject({ teamAShort: 'HOM', teamBShort: 'AWA' })
  })
})

describe('cleanShortName', () => {
  it('capitals, at most 8 characters', () => {
    expect(cleanShortName('abcdefghij')).toBe('ABCDEFGH')
    expect(cleanShortName(null)).toBe('')
  })
})
