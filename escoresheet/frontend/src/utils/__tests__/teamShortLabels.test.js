import { describe, it, expect } from 'vitest'
import { deriveTeamShortLabel, teamShortLabels } from '../teamShortLabels'

describe('deriveTeamShortLabel', () => {
  it('drops the club-type words, any case and with dots', () => {
    expect(deriveTeamShortLabel('VBC Klosterau D2')).toBe('Klosterau D2')
    expect(deriveTeamShortLabel('VC Seehafen Nord')).toBe('Seehafen Nord')
    expect(deriveTeamShortLabel('VBC Musterdorf H1')).toBe('Musterdorf H1')
    expect(deriveTeamShortLabel('Volley Mühletal')).toBe('Mühletal')
    expect(deriveTeamShortLabel('STV St. Musterberg')).toBe('St. Musterberg')
    expect(deriveTeamShortLabel('v.b.c. Muster Unterland D4')).toBe('Muster Unterland D4')
    expect(deriveTeamShortLabel('Volleyball Club')).toBe('Volleyball Club')
    expect(deriveTeamShortLabel('  ')).toBe('')
    expect(deriveTeamShortLabel(null)).toBe('')
  })
})

describe('teamShortLabels', () => {
  it('two teams of the same club type get labels that differ (2026-10-21: "VBC" twice)', () => {
    expect(teamShortLabels({ name: 'VBC Klosterau D2' }, { name: 'VBC Rebberg D1' })).toEqual(['Klosterau D2', 'Rebberg D1'])
  })

  it("prefers the match's short name, then the team's", () => {
    expect(teamShortLabels(
      { shortName: 'KLOS D2', teamShortName: 'KLOS', name: 'VBC Klosterau D2' },
      { teamShortName: 'REBB', name: 'VBC Rebberg D1' }
    )).toEqual(['KLOS D2', 'REBB'])
    expect(teamShortLabels({ shortName: ' ', name: 'VBC Klosterau D2' }, { name: 'VBC Rebberg D1' })).toEqual(['Klosterau D2', 'Rebberg D1'])
  })

  it('equal short names give way to the derived labels, then to the names', () => {
    // generated "VBC" short names (match setup's first word)
    expect(teamShortLabels(
      { shortName: 'VBC', name: 'VBC Klosterau D2' },
      { shortName: 'vbc', name: 'VBC Rebberg D1' }
    )).toEqual(['Klosterau D2', 'Rebberg D1'])
    expect(teamShortLabels({ name: 'VBC Rebberg' }, { name: 'VC Rebberg' })).toEqual(['VBC Rebberg', 'VC Rebberg'])
  })

  it('never the same label, even for two teams of the same name', () => {
    const [a, b] = teamShortLabels({ name: 'VBC Rebberg' }, { name: 'VBC Rebberg' })
    expect(a).not.toBe(b)
    expect([a, b]).toEqual(['Rebberg 1', 'Rebberg 2'])
  })

  it('no name: empty, for the caller to fall back on', () => {
    expect(teamShortLabels({}, { name: 'VBC Rebberg D1' })).toEqual(['', 'Rebberg D1'])
    expect(teamShortLabels()).toEqual(['', ''])
  })
})
