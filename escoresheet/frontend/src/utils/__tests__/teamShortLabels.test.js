import { describe, it, expect } from 'vitest'
import { deriveTeamShortLabel, teamShortLabels } from '../teamShortLabels'

describe('deriveTeamShortLabel', () => {
  it('drops the club-type words, any case and with dots', () => {
    expect(deriveTeamShortLabel('VBC Einsiedeln D2')).toBe('Einsiedeln D2')
    expect(deriveTeamShortLabel('VC Smash Winterthur')).toBe('Smash Winterthur')
    expect(deriveTeamShortLabel('KSC Wiedikon H1')).toBe('Wiedikon H1')
    expect(deriveTeamShortLabel('Volley Näfels')).toBe('Näfels')
    expect(deriveTeamShortLabel('STV St. Gallen')).toBe('St. Gallen')
    expect(deriveTeamShortLabel('v.b.c. Züri Unterland D4')).toBe('Züri Unterland D4')
    expect(deriveTeamShortLabel('Volleyball Club')).toBe('Volleyball Club')
    expect(deriveTeamShortLabel('  ')).toBe('')
    expect(deriveTeamShortLabel(null)).toBe('')
  })
})

describe('teamShortLabels', () => {
  it('two teams of the same club type get labels that differ (2026-10-21: "VBC" twice)', () => {
    expect(teamShortLabels({ name: 'VBC Einsiedeln D2' }, { name: 'VBC Rämi D1' })).toEqual(['Einsiedeln D2', 'Rämi D1'])
  })

  it("prefers the match's short name, then the team's", () => {
    expect(teamShortLabels(
      { shortName: 'EINS D2', teamShortName: 'EINS', name: 'VBC Einsiedeln D2' },
      { teamShortName: 'RÄMI', name: 'VBC Rämi D1' }
    )).toEqual(['EINS D2', 'RÄMI'])
    expect(teamShortLabels({ shortName: ' ', name: 'VBC Einsiedeln D2' }, { name: 'VBC Rämi D1' })).toEqual(['Einsiedeln D2', 'Rämi D1'])
  })

  it('equal short names give way to the derived labels, then to the names', () => {
    // generated "VBC" short names (match setup's first word)
    expect(teamShortLabels(
      { shortName: 'VBC', name: 'VBC Einsiedeln D2' },
      { shortName: 'vbc', name: 'VBC Rämi D1' }
    )).toEqual(['Einsiedeln D2', 'Rämi D1'])
    expect(teamShortLabels({ name: 'VBC Rämi' }, { name: 'VC Rämi' })).toEqual(['VBC Rämi', 'VC Rämi'])
  })

  it('never the same label, even for two teams of the same name', () => {
    const [a, b] = teamShortLabels({ name: 'VBC Rämi' }, { name: 'VBC Rämi' })
    expect(a).not.toBe(b)
    expect([a, b]).toEqual(['Rämi 1', 'Rämi 2'])
  })

  it('no name: empty, for the caller to fall back on', () => {
    expect(teamShortLabels({}, { name: 'VBC Rämi D1' })).toEqual(['', 'Rämi D1'])
    expect(teamShortLabels()).toEqual(['', ''])
  })
})
