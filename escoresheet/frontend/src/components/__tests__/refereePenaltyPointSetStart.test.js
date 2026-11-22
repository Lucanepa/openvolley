// Owner, 15.11: at the start of set 2 the referee tablet showed an empty
// court at 0:1 instead of the set interval (rosters, countdown): a penalty
// point awarded before the first serve counted as the set's start. The
// referee now asks the scorer's rule (domain/rally isFirstRallyOf).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isFirstRallyOf } from '../../domain/rally'

const src = readFileSync(resolve(__dirname, '../Referee.jsx'), 'utf8')
const setBreakSrc = readFileSync(resolve(__dirname, '../referee/setBreak.js'), 'utf8')

describe('referee: a penalty point before the first serve does not start the set', () => {
  it('the rule: only a set start, a rally start or a rally point starts it', () => {
    const penalty = [{ setIndex: 2, type: 'point', payload: { team: 'away', penaltySeq: 41 } }]
    expect(isFirstRallyOf(penalty, 2)).toBe(true)
    expect(isFirstRallyOf([...penalty, { setIndex: 2, type: 'rally_start', payload: {} }], 2)).toBe(false)
  })
  it('the interval, the line-up cover and the line-ups between sets all use it', () => {
    expect(src).toMatch(/import \{ isFirstRallyOf \} from '\.\.\/domain\/rally'/)
    // the interval: the break (referee/setBreak.js refereeSetBreak)
    expect(src).toContain('const isBetweenSets = !!setBreak?.betweenSets')
    expect(setBreakSrc).toContain("import { isFirstRallyOf } from '../../domain/rally'")
    expect(setBreakSrc).toContain('isFirstRallyOf(events, index)')
    expect(src).toContain('const currentSetHasPoints = !isFirstRallyOf(data.events, currentSetIndex)')
    expect(src).toContain('return isFirstRallyOf(data.events, data.currentSet.index)')
    expect(src).not.toMatch(/\(e\.type === 'point' \|\| e\.type === 'set_start'\) && e\.setIndex === currentSetIndex/)
  })
  it('the line-up cover is blurred more (16 px)', () => {
    // one frosted look for both covers; the blur switch off: the near-opaque
    // panel instead (privacyCoverFill, Options › Effects and speed)
    expect(src).toMatch(/const REFEREE_COVER_FROSTED = Object\.freeze\(\{[^}]*backdropFilter: 'blur\(16px\)'/)
    expect(src.match(/\.\.\.privacyCoverFill\(undefined, REFEREE_COVER_FROSTED\)/g)).toHaveLength(2)
  })
})
