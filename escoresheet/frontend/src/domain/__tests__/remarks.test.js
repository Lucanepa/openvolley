import { describe, it, expect } from 'vitest'
import { appendRemark, removeRemarkLine, injurySubstitutionText, liberoUnableText } from '../remarks'
import { isForcedSubstitution } from '../interruptionRequests'

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

describe('eventRemark (owner 2026-10-07: the sheet convention, local time)', () => {
  it('"Set 3, 14:28, B 15:5, #4 injured (bench)"', async () => {
    const { eventRemark, remarkClock } = await import('../remarks.js')
    const at = new Date(2026, 9, 7, 14, 28, 59)
    expect(remarkClock(at)).toBe('14:28')
    expect(eventRemark({ set: 3, at, team: 'B', teamScore: 15, oppScore: 5, text: '#4 injured (bench)' }))
      .toBe('Set 3, 14:28, B 15:5, #4 injured (bench)')
    expect(remarkClock(new Date('nope'))).toBe('')
  })

  it('a Zürich time on a device in another zone (stress test 2026-10-25)', async () => {
    const { remarkClock } = await import('../remarks.js')
    const deviceTz = process.env.TZ
    try {
      for (const tz of ['Etc/GMT-2', 'UTC', 'Asia/Tokyo']) {
        process.env.TZ = tz
        expect(remarkClock(new Date('2026-10-26T09:23:00.000Z')), tz).toBe('10:23')
      }
    } finally {
      if (deviceTz === undefined) delete process.env.TZ
      else process.env.TZ = deviceTz
    }
  })
})

// Remarks are printed and mailed with the scoresheet: the automatic ones say
// what the rules say, never the kind of health problem (privacy policy 7).
describe('the automatic remarks of a player who cannot go on', () => {
  it('use the rules\' words, without "injury"', () => {
    expect(injurySubstitutionText(4)).toBe('#4 substituted, cannot continue playing')
    expect(liberoUnableText(2, 'injury')).toBe('Libero #2 becomes unable to play')
    expect(liberoUnableText(2, 'declared')).toBe('Libero #2 declared unable to play')
    for (const t of [injurySubstitutionText(4), liberoUnableText(2, 'injury')]) expect(t).not.toMatch(/injur|ill/i)
  })
  it('the substitution stays forced by its flag; an older remark is still known', () => {
    expect(isForcedSubstitution({ payload: { isInjury: true, autoRemark: injurySubstitutionText(4) } })).toBe(true)
    expect(isForcedSubstitution({ payload: { autoRemark: 'Set 1, A 3:1, #4 substituted due to injury' } })).toBe(true)
  })
})
