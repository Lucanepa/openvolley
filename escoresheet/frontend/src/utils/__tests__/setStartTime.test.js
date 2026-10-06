import { describe, it, expect } from 'vitest'
import { defaultSetStartTime } from '../setStartTime'

const at = (iso) => new Date(iso)

describe('defaultSetStartTime', () => {
  it('set 1 starts when its first rally starts, not at the scheduled time', () => {
    // scheduled 18:00, first rally at 18:06:40
    expect(defaultSetStartTime({ setIndex: 1, sets: [{ index: 1 }], now: at('2026-10-05T18:06:40Z') }))
      .toBe('2026-10-05T18:06:00.000Z')
  })

  it('a later set starts now even when the interval was ended early (never after its own end)', () => {
    const sets = [{ index: 1, endTime: '2026-10-05T18:06:00Z' }, { index: 2 }]
    // interval ended after 1 minute: previous end + 3 min would be 18:09, after the set 2 rallies
    expect(defaultSetStartTime({ setIndex: 2, sets, now: at('2026-10-05T18:07:10Z') }))
      .toBe('2026-10-05T18:07:00.000Z')
  })

  it('is never before the end of the last set played (device clock behind)', () => {
    const sets = [{ index: 1, endTime: '2026-10-05T18:20:00Z' }, { index: 2, endTime: '2026-10-05T18:45:30Z' }, { index: 5 }]
    // best-of-3 deciding set (internal index 5) follows set 2, not a missing set 4
    expect(defaultSetStartTime({ setIndex: 5, sets, now: at('2026-10-05T18:44:00Z') }))
      .toBe('2026-10-05T18:45:00.000Z')
    expect(defaultSetStartTime({ setIndex: 5, sets, now: at('2026-10-05T18:49:59Z') }))
      .toBe('2026-10-05T18:49:00.000Z')
  })

  it('ignores later sets and unparseable end times', () => {
    const sets = [{ index: 1, endTime: 'garbage' }, { index: 3, endTime: '2026-10-05T23:00:00Z' }]
    expect(defaultSetStartTime({ setIndex: 2, sets, now: at('2026-10-05T18:30:00Z') }))
      .toBe('2026-10-05T18:30:00.000Z')
  })
})
