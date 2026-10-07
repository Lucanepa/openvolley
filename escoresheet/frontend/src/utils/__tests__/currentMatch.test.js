import { describe, it, expect } from 'vitest'
import { ABANDONED_LOCAL_MATCH_MS, isAbandonedLocalMatch, needsEventCheck, pickCurrentMatch } from '../currentMatch'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const at = (ms) => new Date(ms).toISOString()

describe('current match of the scorer app', () => {
  it('an old live match does not beat a newer unfinished one: the newest by createdAt wins', () => {
    const matches = [
      { id: 1, status: 'live', createdAt: at(NOW - 2 * DAY) },
      { id: 2, status: 'setup', createdAt: at(NOW - DAY) },
      { id: 3, status: 'final', createdAt: at(NOW - 1000) }
    ]
    expect(pickCurrentMatch(matches, { now: NOW }).id).toBe(2)
  })

  it('a match created more than 7 days ago without events is never current', () => {
    const abandoned = { id: 'feb', status: 'live', createdAt: '2026-02-20T10:00:00.000Z' }
    expect(pickCurrentMatch([abandoned], { now: NOW })).toBeNull()
    expect(isAbandonedLocalMatch(abandoned, { now: NOW })).toBe(true)
  })

  it('an old match with events was played: it stays current until finished', () => {
    const played = { id: 'old', status: 'live', createdAt: at(NOW - 10 * DAY) }
    expect(pickCurrentMatch([played], { now: NOW, hasEvents: (id) => id === 'old' })).toBe(played)
  })

  it('skips the abandoned one and takes the next', () => {
    const matches = [
      { id: 'new-but-abandoned', status: 'setup', createdAt: at(NOW - 8 * DAY) },
      { id: 'older-played', status: 'live', createdAt: at(NOW - 9 * DAY) }
    ]
    expect(pickCurrentMatch(matches, { now: NOW, hasEvents: (id) => id === 'older-played' }).id).toBe('older-played')
  })

  it('the 7-day line, and only old matches need an events lookup', () => {
    expect(ABANDONED_LOCAL_MATCH_MS).toBe(7 * DAY)
    expect(needsEventCheck({ createdAt: at(NOW - 6 * DAY) }, NOW)).toBe(false)
    expect(needsEventCheck({ createdAt: at(NOW - 8 * DAY) }, NOW)).toBe(true)
    expect(needsEventCheck({ createdAt: NOW - 8 * DAY }, NOW)).toBe(true)
    expect(needsEventCheck({}, NOW)).toBe(false)
  })

  it('a match without createdAt counts, after the dated ones', () => {
    const undated = { id: 'u', status: 'setup' }
    expect(pickCurrentMatch([undated], { now: NOW })).toBe(undated)
    expect(pickCurrentMatch([undated, { id: 'd', status: 'setup', createdAt: at(NOW - DAY) }], { now: NOW }).id).toBe('d')
  })

  it('nothing: null', () => {
    expect(pickCurrentMatch([], { now: NOW })).toBeNull()
    expect(pickCurrentMatch(null, { now: NOW })).toBeNull()
    expect(pickCurrentMatch([{ id: 1, status: 'final', createdAt: at(NOW) }], { now: NOW })).toBeNull()
  })
})
