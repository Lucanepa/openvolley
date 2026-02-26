import { describe, it, expect } from 'vitest'
import { setsToWin, isMatchFinished, getNextSetIndex } from '../matchFormat'

describe('setsToWin', () => {
  it('returns 3 for best-of-5 (default)', () => {
    expect(setsToWin()).toBe(3)
    expect(setsToWin(5)).toBe(3)
  })

  it('returns 2 for best-of-3', () => {
    expect(setsToWin(3)).toBe(2)
  })

  it('returns 3 for any non-3 value', () => {
    expect(setsToWin(1)).toBe(3)
    expect(setsToWin(7)).toBe(3)
  })
})

describe('isMatchFinished', () => {
  describe('best-of-5', () => {
    it('returns false when neither team has 3 sets', () => {
      expect(isMatchFinished(0, 0)).toBe(false)
      expect(isMatchFinished(1, 2)).toBe(false)
      expect(isMatchFinished(2, 2)).toBe(false)
    })

    it('returns true when home team wins 3 sets', () => {
      expect(isMatchFinished(3, 0)).toBe(true)
      expect(isMatchFinished(3, 1)).toBe(true)
      expect(isMatchFinished(3, 2)).toBe(true)
    })

    it('returns true when away team wins 3 sets', () => {
      expect(isMatchFinished(0, 3)).toBe(true)
      expect(isMatchFinished(1, 3)).toBe(true)
      expect(isMatchFinished(2, 3)).toBe(true)
    })
  })

  describe('best-of-3', () => {
    it('returns false when neither team has 2 sets', () => {
      expect(isMatchFinished(0, 0, 3)).toBe(false)
      expect(isMatchFinished(1, 0, 3)).toBe(false)
      expect(isMatchFinished(1, 1, 3)).toBe(false)
    })

    it('returns true when home team wins 2 sets', () => {
      expect(isMatchFinished(2, 0, 3)).toBe(true)
      expect(isMatchFinished(2, 1, 3)).toBe(true)
    })

    it('returns true when away team wins 2 sets', () => {
      expect(isMatchFinished(0, 2, 3)).toBe(true)
      expect(isMatchFinished(1, 2, 3)).toBe(true)
    })
  })
})

describe('getNextSetIndex', () => {
  describe('best-of-5', () => {
    it('returns sequential next index', () => {
      expect(getNextSetIndex(1, 1, 0)).toBe(2)
      expect(getNextSetIndex(2, 2, 0)).toBe(3)
      expect(getNextSetIndex(3, 2, 1)).toBe(4)
      expect(getNextSetIndex(4, 2, 2)).toBe(5)
    })
  })

  describe('best-of-3', () => {
    it('returns sequential for non-tiebreak sets', () => {
      expect(getNextSetIndex(1, 1, 0, 3)).toBe(2)
      expect(getNextSetIndex(1, 0, 1, 3)).toBe(2)
    })

    it('jumps to set 5 for tiebreak when tied 1-1 after set 2', () => {
      expect(getNextSetIndex(2, 1, 1, 3)).toBe(5)
    })

    it('does NOT jump when not tied after set 2', () => {
      expect(getNextSetIndex(2, 2, 0, 3)).toBe(3)
      expect(getNextSetIndex(2, 0, 2, 3)).toBe(3)
    })
  })
})
