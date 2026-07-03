import { describe, it, expect } from 'vitest'
import {
  nextDelaySanction,
  improperRequestConsequence,
  resolveSanction,
  isDelaySanction,
  awardsPoint,
} from '../sanctions'

describe('nextDelaySanction (FIVB 16.2)', () => {
  it('first delay in the match is a warning', () => {
    expect(nextDelaySanction(0)).toBe('delay_warning')
  })
  it('every subsequent delay is a penalty', () => {
    expect(nextDelaySanction(1)).toBe('delay_penalty')
    expect(nextDelaySanction(2)).toBe('delay_penalty')
    expect(nextDelaySanction(5)).toBe('delay_penalty')
  })
})

describe('improperRequestConsequence (FIVB 15.11)', () => {
  it('first improper request is recorded with no other consequence', () => {
    expect(improperRequestConsequence(0, 0)).toBe('improper_request')
  })
  it('a second improper request becomes a delay (enters the ladder)', () => {
    // no prior delay -> the delay is a warning
    expect(improperRequestConsequence(1, 0)).toBe('delay_warning')
    // team already had a delay -> the delay is a penalty
    expect(improperRequestConsequence(1, 1)).toBe('delay_penalty')
    expect(improperRequestConsequence(2, 2)).toBe('delay_penalty')
  })
})

describe('resolveSanction (enforces the ladder from scorer intent + history)', () => {
  it('a requested delay is forced to a warning first, penalty after', () => {
    expect(resolveSanction('delay_penalty', { priorDelayCount: 0 })).toBe('delay_warning')
    expect(resolveSanction('delay_warning', { priorDelayCount: 1 })).toBe('delay_penalty')
  })
  it('a first improper request stays an improper request', () => {
    expect(resolveSanction('improper_request', { priorImproperCount: 0 })).toBe('improper_request')
  })
  it('a repeat improper request escalates through the delay ladder', () => {
    expect(resolveSanction('improper_request', { priorImproperCount: 1, priorDelayCount: 0 })).toBe('delay_warning')
    expect(resolveSanction('improper_request', { priorImproperCount: 1, priorDelayCount: 1 })).toBe('delay_penalty')
  })
  it('passes through unrelated types unchanged', () => {
    expect(resolveSanction('penalty', {})).toBe('penalty')
  })
})

describe('helpers', () => {
  it('isDelaySanction', () => {
    expect(isDelaySanction('delay_warning')).toBe(true)
    expect(isDelaySanction('delay_penalty')).toBe(true)
    expect(isDelaySanction('improper_request')).toBe(false)
  })
  it('awardsPoint: only delay_penalty and misconduct penalty award a point', () => {
    expect(awardsPoint('delay_penalty')).toBe(true)
    expect(awardsPoint('penalty')).toBe(true)
    expect(awardsPoint('delay_warning')).toBe(false)
    expect(awardsPoint('improper_request')).toBe(false)
  })
})
