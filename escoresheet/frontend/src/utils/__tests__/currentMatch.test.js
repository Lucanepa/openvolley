import { describe, it, expect } from 'vitest'
import { ABANDONED_LOCAL_MATCH_MS, isAbandonedLocalMatch, needsEventCheck, pickCurrentMatch, newOfficialMatchStep } from '../currentMatch'

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

  it('a match set up more than 7 days ahead of its date, or edited lately, is not abandoned', () => {
    const prepared = { id: 'prep', status: 'setup', createdAt: at(NOW - 10 * DAY), scheduledAt: at(NOW + 6 * 60 * 60 * 1000) }
    expect(needsEventCheck(prepared, NOW)).toBe(false)
    expect(pickCurrentMatch([prepared], { now: NOW })).toBe(prepared)
    // local wall time without zone (MatchSetup's official-match loader)
    expect(needsEventCheck({ createdAt: at(NOW - 10 * DAY), scheduledAt: '2026-10-07T18:00:00' }, NOW)).toBe(false)
    const edited = { id: 'ed', status: 'setup', createdAt: at(NOW - 10 * DAY), updatedAt: at(NOW - DAY) }
    expect(pickCurrentMatch([edited], { now: NOW })).toBe(edited)
    // scheduled long ago, untouched since: abandoned (the June "Home – Away")
    const june = { id: 'june', status: 'live', createdAt: '2026-02-20T10:00:00.000Z', scheduledAt: '2026-06-15T16:00:00' }
    expect(needsEventCheck(june, NOW)).toBe(true)
    expect(pickCurrentMatch([june, prepared], { now: NOW })).toBe(prepared)
  })

  it('nothing: null', () => {
    expect(pickCurrentMatch([], { now: NOW })).toBeNull()
    expect(pickCurrentMatch(null, { now: NOW })).toBeNull()
    expect(pickCurrentMatch([{ id: 1, status: 'final', createdAt: at(NOW) }], { now: NOW })).toBeNull()
  })
})

// "New match → Official match" did nothing at all, no dialog, no message,
// while a test match was being recorded (stress test 2026-10-25): the
// button returned on any match being recorded, test and easy ones too.
describe('New match → Official match with the current match', () => {
  const confirmed = { matchInfoConfirmedAt: at(NOW - DAY) }

  it('a test (or easy) match being recorded is replaced after a question, as one not being recorded is', () => {
    expect(newOfficialMatchStep({ id: 1, test: true, ...confirmed }, 'Match recording')).toBe('replace')
    expect(newOfficialMatchStep({ id: 1, test: true, easy: true, ...confirmed }, 'Match recording')).toBe('replace')
    expect(newOfficialMatchStep({ id: 1, test: true, ...confirmed }, 'Coin toss')).toBe('replace')
  })

  it('an official match being recorded is not replaced: the scorer is told why', () => {
    expect(newOfficialMatchStep({ id: 1, ...confirmed }, 'Match recording')).toBe('recording')
  })

  it('otherwise as before: a confirmed match is asked about, a draft deleted, none opens the setup', () => {
    expect(newOfficialMatchStep({ id: 1, ...confirmed }, 'Setup')).toBe('replace')
    expect(newOfficialMatchStep({ id: 1 }, 'Setup')).toBe('discard')
    expect(newOfficialMatchStep(null, undefined)).toBe('new')
  })

  // The owner, 2026-10-27: a copy the server has closed, or one another
  // device scores now, never blocks a new match and is never deleted on the
  // way (it was replaced after a question, or blocked as "still recording");
  // it stays on the device, read-only, with its state on the home screen
  it('a copy closed on the server or scored on another device: the setup opens, the copy stays', () => {
    expect(newOfficialMatchStep({ id: 1 }, 'No data', { closedCopy: true })).toBe('new')
    expect(newOfficialMatchStep({ id: 1, ...confirmed }, 'Match ended', { closedCopy: true })).toBe('new')
    expect(newOfficialMatchStep({ id: 1, ...confirmed }, 'Match recording', { movedCopy: true })).toBe('new')
  })
})
