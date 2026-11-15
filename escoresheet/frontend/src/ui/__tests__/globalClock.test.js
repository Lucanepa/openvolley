import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { timeLabel, dayKey, zurichWallTimeMs, currentTz } from '../format'
import { nowTime } from '../dateTime'
import { formatZurichDateTime } from '../../utils/dateFormatter'
import { setToolMode } from '../../utils/toolMode'

// Swiss: every clock is Zürich's. Global (owner 2026-11-15): the device's own.
const deviceIn = (timeZone) => vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone, locale: 'en-GB' })

describe('clock zone: Swiss vs Global', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('Swiss (and a device that never chose): Zürich, whatever the device zone is', () => {
    deviceIn('Europe/London')
    expect(currentTz()).toBe('Europe/Zurich')
    expect(timeLabel('2026-11-15T09:00:00Z')).toBe('10:00')
    setToolMode('swiss')
    expect(timeLabel('2026-11-15T09:00:00Z')).toBe('10:00')
    expect(zurichWallTimeMs(2026, 11, 15, 9, 0)).toBe(Date.UTC(2026, 10, 15, 8, 0))
  })

  it('Global: the device zone, for a London school as for Tokyo', () => {
    setToolMode('global')
    deviceIn('Europe/London')
    expect(currentTz()).toBe('Europe/London')
    expect(timeLabel('2026-11-15T09:00:00Z')).toBe('09:00')
    expect(zurichWallTimeMs(2026, 11, 15, 9, 0)).toBe(Date.UTC(2026, 10, 15, 9, 0)) // a typed 09:00 is 09:00 there
    vi.restoreAllMocks()
    deviceIn('Asia/Tokyo')
    expect(timeLabel('2026-11-15T09:00:00Z')).toBe('18:00')
  })

  it('Global: the day follows the device (late evening is not the next day in Zürich)', () => {
    setToolMode('global')
    deviceIn('America/New_York')
    expect(dayKey('2026-11-15T03:30:00Z')).toBe('2026-11-14') // 22:30 on the 14th there
    vi.restoreAllMocks()
    setToolMode('swiss')
    expect(dayKey('2026-11-15T03:30:00Z')).toBe('2026-11-15') // 04:30 in Zürich
  })

  it('Global: the clock now and the formatted date-times follow it', () => {
    setToolMode('global')
    deviceIn('Asia/Tokyo')
    const at = new Date('2026-11-15T09:07:30Z')
    expect(nowTime(1, at)).toBe('18:07')
    expect(formatZurichDateTime(at)).toBe('15.11.2026, 18:07:30')
    setToolMode('swiss')
    expect(nowTime(1, at)).toBe('10:07')
    expect(formatZurichDateTime(at)).toBe('15.11.2026, 10:07:30')
  })

  it('a wall-clock string with no zone stays as written in both', () => {
    setToolMode('global')
    deviceIn('Asia/Tokyo')
    expect(timeLabel('2026-11-15T09:00')).toBe('09:00')
  })
})
