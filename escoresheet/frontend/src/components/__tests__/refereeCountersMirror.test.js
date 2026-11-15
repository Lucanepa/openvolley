// Owner, 15.11 (referee tablet, upright): TO SUB | SUB TO, and the Sanctions
// block only when the team has a sanction.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { hasTeamSanctions } from '../referee/SanctionCards.jsx'

const src = readFileSync(resolve(__dirname, '../Referee.jsx'), 'utf8')

describe('referee strip: mirrored counters, sanctions only when there are some', () => {
  it('hasTeamSanctions: any card or a delay sanction', () => {
    expect(hasTeamSanctions(null)).toBe(false)
    expect(hasTeamSanctions({ warnings: [], penalties: [], expulsions: [], disqualifications: [] })).toBe(false)
    expect(hasTeamSanctions({ warnings: [{ id: 7 }] })).toBe(true)
    expect(hasTeamSanctions({ delayWarning: true })).toBe(true)
  })
  it('the right team\'s counters are mirrored (SUB before TO), the left\'s are not', () => {
    expect(src).toContain("{counters(stats, side, true, side === 'right')}")
    const body = src.slice(src.indexOf('const counters = (stats, area, row, mirrored = false) => ('), src.indexOf("const sanctionsTitle"))
    const subFirst = body.indexOf("{mirrored && counter('SUB'")
    const to = body.indexOf("{counter('TO'")
    const subLast = body.indexOf("{!mirrored && counter('SUB'")
    expect(subFirst).toBeGreaterThan(-1)
    expect(subFirst).toBeLessThan(to)
    expect(to).toBeLessThan(subLast)
  })
  it('the sanctions block and its divider show only with a sanction', () => {
    expect(src).toContain('const sanctions = (teamSanctions, area) => !hasTeamSanctions(teamSanctions)')
    expect(src).toMatch(/\{hasTeamSanctions\(teamSanctions\) && \(\s*<>\s*<div style=\{\{ borderTop/)
  })
})
