import { describe, it, expect } from 'vitest'
import { rowSummary } from '../manage/RevisionsList'

const row = (type, payload, extra = {}) => ({ type, payload, score_a: 0, score_b: 0, ...extra })

describe('RevisionsList rowSummary', () => {
  it('shows a libero entry as player → libero', () => {
    expect(rowSummary(row('libero_entry', { team: 'away', position: 'V', playerOut: 16, liberoIn: 20, liberoType: 'libero1' })))
      .toBe('libero_entry · away · 16→L 20 · 0:0')
  })

  it('shows a libero exit as libero → player', () => {
    expect(rowSummary(row('libero_exit', { team: 'home', liberoOut: 20, playerIn: 16 })))
      .toBe('libero_exit · home · L 20→16 · 0:0')
  })

  it('shows a libero exchange as libero → libero, without the replaced player', () => {
    expect(rowSummary(row('libero_exchange', { team: 'home', liberoOut: 20, liberoIn: 2, playerNumber: 16 })))
      .toBe('libero_exchange · home · L 20→L 2 · 0:0')
  })

  it('keeps substitutions as before', () => {
    expect(rowSummary(row('substitution', { team: 'home', playerOut: 7, playerIn: 9 }, { score_a: 3, score_b: 5 })))
      .toBe('substitution · home · 7→9 · 3:5')
  })

  it('never prints undefined for a missing side', () => {
    const texts = [
      rowSummary(row('libero_entry', { team: 'away', playerOut: 16 })),
      rowSummary(row('libero_exit', { team: 'away', playerIn: 16 })),
      rowSummary(row('libero_exchange', { team: 'away', liberoIn: 2 })),
      rowSummary(row('substitution', { team: 'away', playerOut: 7 })),
      rowSummary({ type: 'libero_entry' })
    ]
    expect(texts).toEqual(['libero_entry · away · 16 · 0:0', 'libero_exit · away · 16 · 0:0', 'libero_exchange · away · L 2 · 0:0', 'substitution · away · 7 · 0:0', 'libero_entry'])
    for (const s of texts) expect(s).not.toMatch(/undefined|null/)
  })
})
