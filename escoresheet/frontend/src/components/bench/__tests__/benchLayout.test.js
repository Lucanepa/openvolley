import { describe, it, expect } from 'vitest'
import { counterTone, counterPips, benchShortName, TIMEOUT_LIMIT, SUBSTITUTION_LIMIT } from '../benchLayout.js'

describe('counterTone', () => {
  it('marks a used-up limit', () => {
    expect(counterTone(2, TIMEOUT_LIMIT)).toBe('max')
    expect(counterTone(6, SUBSTITUTION_LIMIT, { warnNear: true })).toBe('max')
    expect(counterTone(7, SUBSTITUTION_LIMIT)).toBe('max')
  })
  it('warns one before the limit only when asked (the fifth substitution)', () => {
    expect(counterTone(5, SUBSTITUTION_LIMIT, { warnNear: true })).toBe('near')
    expect(counterTone(1, TIMEOUT_LIMIT)).toBe(null)
    expect(counterTone(4, SUBSTITUTION_LIMIT, { warnNear: true })).toBe(null)
  })
  it('reads a missing count as none used', () => {
    expect(counterTone(undefined, TIMEOUT_LIMIT)).toBe(null)
  })
})

describe('counterPips', () => {
  it('fills one pip per used request', () => {
    expect(counterPips(1, 2)).toEqual([true, false])
    expect(counterPips(0, 6)).toEqual([false, false, false, false, false, false])
  })
  it('never draws more pips than the limit', () => {
    expect(counterPips(9, 2)).toEqual([true, true])
    expect(counterPips(-1, 2)).toEqual([false, false])
  })
})

describe('benchShortName', () => {
  it('prefers the match short name, then the team, then the name', () => {
    expect(benchShortName('home', { homeShortName: 'MUSTER' }, { name: 'VBC Musterdorf' })).toBe('MUSTER')
    expect(benchShortName('away', {}, { shortName: 'BEISPIEL', name: 'Volley Beispiel' })).toBe('BEISPIEL')
    expect(benchShortName('away', null, { name: 'Volley Beispiel' })).toBe('Volley Beispiel')
    expect(benchShortName('home', null, null)).toBe('')
  })
})
