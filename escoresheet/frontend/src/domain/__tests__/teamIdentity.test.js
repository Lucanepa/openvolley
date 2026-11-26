// A name or a shirt colour changed after the coin toss (Edit match info) must
// reach the live state the referee and bench tablets, the livescore and Point
// Hub read (team_a_name / team_a_color): the scoring screen builds it from the
// match row first, so the editor writes the match row's mirror fields too.
// The short name is retired (26.11.2026): team_a_short is derived from the name.
import { describe, it, expect } from 'vitest'
import { deriveTeamShortLabel, liveTeamIdentity, teamMirrorPatch } from '../teamIdentity'

const homeTeam = { id: 1, name: 'VBC Home', shortName: 'OLD', color: '#ef4444' }
const awayTeam = { id: 2, name: 'VC Away', color: '#3b82f6' }
const match = { homeTeamId: 1, awayTeamId: 2, coinTossTeamA: 'away', homeName: 'VBC Home', awayName: 'VC Away', homeShortName: 'OLD', homeColor: '#ef4444', awayColor: '#3b82f6' }

describe('teamMirrorPatch', () => {
  it('writes only the fields that changed, never a short name', () => {
    expect(teamMirrorPatch({ home: homeTeam, away: awayTeam }, { home: { ...homeTeam, shortName: 'NEW' }, away: { ...awayTeam, color: '#1d4ed8' } }))
      .toEqual({ awayColor: '#1d4ed8' })
  })

  it('nothing changed: nothing written (a match row with server names keeps them)', () => {
    expect(teamMirrorPatch({ home: homeTeam, away: awayTeam }, { home: { ...homeTeam }, away: { ...awayTeam } })).toEqual({})
  })

  it('a name edited at the match end goes to the match row too', () => {
    expect(teamMirrorPatch({ home: homeTeam }, { home: { ...homeTeam, name: 'VBC Home 2' } })).toEqual({ homeName: 'VBC Home 2' })
  })
})

describe('liveTeamIdentity', () => {
  it('team A is the coin toss winner; the short label comes from the name, not a stored short name', () => {
    expect(liveTeamIdentity(match, homeTeam, awayTeam)).toEqual({
      teamAKey: 'away',
      teamAName: 'VC Away', teamAShort: 'Away', teamAColor: '#3b82f6',
      teamBName: 'VBC Home', teamBShort: 'Home', teamBColor: '#ef4444'
    })
  })

  it('a name edit after the coin toss reaches team_a_name and team_a_short', () => {
    const before = { home: homeTeam, away: awayTeam }
    const after = { home: { ...homeTeam, name: 'VBC Neu', color: '#22c55e' }, away: awayTeam }
    const live = liveTeamIdentity({ ...match, ...teamMirrorPatch(before, after) }, after.home, after.away)
    expect(live).toMatchObject({ teamBName: 'VBC Neu', teamBShort: 'Neu', teamBColor: '#22c55e' })
  })

  it('no name on the match: the team record\'s', () => {
    expect(liveTeamIdentity({ coinTossTeamA: 'home' }, homeTeam, { name: 'Away VC' })).toMatchObject({ teamAName: 'VBC Home', teamBShort: 'Away' })
  })
})

describe('deriveTeamShortLabel', () => {
  it('drops the club-type words, any case and with dots', () => {
    expect(deriveTeamShortLabel('VBC Klosterau D2')).toBe('Klosterau D2')
    expect(deriveTeamShortLabel('Volley Mühletal')).toBe('Mühletal')
    expect(deriveTeamShortLabel('STV St. Musterberg')).toBe('St. Musterberg')
    expect(deriveTeamShortLabel('v.b.c. Muster Unterland D4')).toBe('Muster Unterland D4')
    expect(deriveTeamShortLabel('Volleyball Club')).toBe('Volleyball Club')
    expect(deriveTeamShortLabel('  ')).toBe('')
    expect(deriveTeamShortLabel(null)).toBe('')
  })
})
