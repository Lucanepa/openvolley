import { describe, it, expect } from 'vitest'
import { appendRemark, removeRemarkLine } from '../remarks'

describe('appendRemark', () => {
  it('starts the text or appends a line', () => {
    expect(appendRemark('', 'a')).toBe('a')
    expect(appendRemark(undefined, 'a')).toBe('a')
    expect(appendRemark('a', 'b')).toBe('a\nb')
  })
  it('ignores an empty line', () => {
    expect(appendRemark('a', '')).toBe('a')
  })
})

describe('removeRemarkLine', () => {
  it('removes the line and keeps the others', () => {
    expect(removeRemarkLine('a\nb\nc', 'b')).toBe('a\nc')
    expect(removeRemarkLine('a', 'a')).toBe('')
  })
  it('removes only the last occurrence', () => {
    expect(removeRemarkLine('x\ny\nx', 'x')).toBe('x\ny')
  })
  it('leaves the text alone when the line was edited away', () => {
    expect(removeRemarkLine('a\nb (edited)', 'b')).toBe('a\nb (edited)')
  })
  it('round-trips with appendRemark', () => {
    const before = 'manual note'
    expect(removeRemarkLine(appendRemark(before, 'Set 1, Team A, ...'), 'Set 1, Team A, ...')).toBe(before)
  })
})
