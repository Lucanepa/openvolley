import { describe, it, expect } from 'vitest'
import { buildPlayerPool, preselectedKeys, selectionIssues, poolToRoster, poolKey, ROSTER_MAX } from '../playerPool'

const p = (number, lastName, firstName = 'A', over = {}) => ({ number, lastName, firstName, dob: '', libero: '', isCaptain: false, isLfp: false, ...over })

describe('buildPlayerPool', () => {
  it('merges a player found in several sources by name, the first source giving the number', () => {
    const pool = buildPlayerPool({
      current: [p(7, 'Keller', 'Anna')],
      saved: [p(9, 'keller ', 'anna', { dob: '01.02.2003' }), p(3, 'Meier', 'Lea')],
      earlier: [[p(7, 'Keller', 'Anna'), p(11, 'Brunner', 'Mia')]]
    })
    expect(pool.map(e => [e.number, e.lastName])).toEqual([[3, 'Meier'], [7, 'Keller'], [11, 'Brunner']])
    const keller = pool.find(e => e.lastName === 'Keller')
    expect(keller.sources).toEqual(['current', 'saved', 'earlier'])
    expect(keller.dob).toBe('01.02.2003')
    expect(keller.lastMatch).toBe(true)
    expect(pool.find(e => e.lastName === 'Meier').lastMatch).toBe(false)
  })

  it('keeps two players of one name apart when their dates of birth differ', () => {
    const pool = buildPlayerPool({ saved: [p(1, 'Huber', 'Sara', { dob: '01.01.2000' })], earlier: [[p(2, 'Huber', 'Sara', { dob: '05.05.2005' })]] })
    expect(pool).toHaveLength(2)
  })

  it('keys a player without a name by the number, and drops empty rows', () => {
    expect(poolKey(p(4, '', ''))).toBe('#:4')
    expect(buildPlayerPool({ current: [p(null, '', ''), p(4, '', '')] })).toHaveLength(1)
  })

  it('only the newest earlier roster is the last match', () => {
    const pool = buildPlayerPool({ earlier: [[p(1, 'A')], [p(2, 'B')]] })
    expect(pool.find(e => e.number === 1).lastMatch).toBe(true)
    expect(pool.find(e => e.number === 2).lastMatch).toBe(false)
  })

  it('keeps the libero slot and the captain of the first source', () => {
    const [e] = buildPlayerPool({ saved: [p(5, 'Libero', 'X', { libero: 'libero2', isCaptain: true })] })
    expect(e).toMatchObject({ isLibero: true, liberoSlot: 'libero2', isCaptain: true })
  })
})

describe('preselectedKeys', () => {
  it('ticks the roster in the setup when there is one', () => {
    const pool = buildPlayerPool({ current: [p(1, 'A')], saved: [p(2, 'B')] })
    expect([...preselectedKeys(pool)]).toEqual([poolKey(p(1, 'A'))])
  })

  it('else the Einsatzliste players of the last match, else the whole Einsatzliste', () => {
    const pool = buildPlayerPool({ imported: [p(1, 'A'), p(2, 'B'), p(3, 'C')], earlier: [[p(2, 'B'), p(9, 'Z')]] })
    expect([...preselectedKeys(pool)]).toEqual([poolKey(p(2, 'B'))])
    const fresh = buildPlayerPool({ imported: [p(1, 'A'), p(2, 'B')], earlier: [[p(9, 'Z')]] })
    expect(preselectedKeys(fresh).size).toBe(2)
  })

  it('else the players of the last match, else all', () => {
    const pool = buildPlayerPool({ saved: [p(1, 'A'), p(2, 'B')], earlier: [[p(2, 'B')]] })
    expect([...preselectedKeys(pool)]).toEqual([poolKey(p(2, 'B'))])
    expect(preselectedKeys(buildPlayerPool({ saved: [p(1, 'A'), p(2, 'B')] })).size).toBe(2)
  })
})

describe('selectionIssues', () => {
  const many = (n, liberos = 0) => buildPlayerPool({ saved: Array.from({ length: n }, (_, i) => p(i + 1, `P${i + 1}`, 'A', { libero: i < liberos ? 'libero1' : '' })) })
  it('warns above 14, above 12 without two liberos, for a third libero and under 6', () => {
    expect(selectionIssues(many(ROSTER_MAX + 1, 2)).map(i => i.key)).toEqual(['playerPool.tooMany'])
    expect(selectionIssues(many(13, 1)).map(i => i.key)).toEqual(['playerPool.twoLiberos'])
    expect(selectionIssues(many(12, 3)).map(i => i.key)).toEqual(['playerPool.tooManyLiberos'])
    expect(selectionIssues(many(4)).map(i => i.key)).toEqual(['playerPool.tooFew'])
    expect(selectionIssues(many(12, 2))).toEqual([])
    expect(selectionIssues([])).toEqual([])
  })
})

describe('poolToRoster', () => {
  it('gives roster entries by number, liberos keeping their slot and one captain', () => {
    const pool = buildPlayerPool({ saved: [
      p(9, 'C', 'A', { libero: 'libero2' }), p(3, 'B', 'A', { libero: 'libero1' }), p(12, 'D', 'A', { libero: 'libero1' }),
      p(1, 'A', 'A', { isCaptain: true }), p(5, 'E', 'A', { isCaptain: true })
    ] })
    const roster = poolToRoster(pool)
    expect(roster.map(r => r.number)).toEqual([1, 3, 5, 9, 12])
    expect(roster.map(r => r.libero)).toEqual(['', 'libero1', '', 'libero2', ''])
    expect(roster.filter(r => r.isCaptain).map(r => r.number)).toEqual([1])
  })

  it('makes the one libero left L1 when the first libero is not ticked', () => {
    const pool = buildPlayerPool({ saved: [p(3, 'B', 'A', { libero: 'libero1' }), p(9, 'C', 'A', { libero: 'libero2' })] })
    const roster = poolToRoster(pool.filter(e => e.number === 9))
    expect(roster[0].libero).toBe('libero1')
  })
})
