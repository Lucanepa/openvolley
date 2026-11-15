// Owner, 15.11: the header showed the referee tablet as "0/1" while it was
// connected: the chip asked about the newest unfinished match (a test match
// made that day), not the open official match the relay publishes.
import { describe, it, expect } from 'vitest'
import { relayPublishedMatch } from '../currentMatch'

const official = { id: 7, seed_key: 'off', test: false }
const newerTest = { id: 9, seed_key: 'tst', test: true }

describe('relayPublishedMatch: the match whose tablets count', () => {
  it('an open older match wins over a newer unfinished test match', () => {
    expect(relayPublishedMatch(7, official, newerTest)).toBe(official)
  })
  it('on Home (no open match): the newest unfinished one, as the relay publishes it', () => {
    expect(relayPublishedMatch(null, null, newerTest)).toBe(newerTest)
    expect(relayPublishedMatch(undefined, undefined, null)).toBeNull()
  })
  it('while the open match row is loading (or is another row): nothing, never the other match', () => {
    expect(relayPublishedMatch(7, undefined, newerTest)).toBeNull()
    expect(relayPublishedMatch(7, newerTest, newerTest)).toBeNull()
  })
  it('ids compare as strings (route ids are strings)', () => {
    expect(relayPublishedMatch('7', official, newerTest)).toBe(official)
  })
})
