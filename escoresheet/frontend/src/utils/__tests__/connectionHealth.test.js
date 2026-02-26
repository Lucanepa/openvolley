import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getHeartbeatHealth, getTabletStatusSummary, formatAge } from '../connectionHealth'

describe('getHeartbeatHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns disconnected for null heartbeat', () => {
    const result = getHeartbeatHealth(null)
    expect(result.status).toBe('disconnected')
    expect(result.color).toBe('#ef4444')
    expect(result.ageMs).toBeNull()
  })

  it('returns disconnected for invalid heartbeat', () => {
    const result = getHeartbeatHealth('not-a-date')
    expect(result.status).toBe('disconnected')
    expect(result.ageMs).toBeNull()
  })

  it('returns connected for recent heartbeat (< 15s)', () => {
    const recent = new Date(Date.now() - 5000).toISOString()
    const result = getHeartbeatHealth(recent)
    expect(result.status).toBe('connected')
    expect(result.color).toBe('#22c55e')
    expect(result.ageMs).toBeCloseTo(5000, -2)
  })

  it('returns stale for heartbeat between 15s and 30s', () => {
    const stale = new Date(Date.now() - 20000).toISOString()
    const result = getHeartbeatHealth(stale)
    expect(result.status).toBe('stale')
    expect(result.color).toBe('#eab308')
  })

  it('returns disconnected for heartbeat older than 30s', () => {
    const old = new Date(Date.now() - 60000).toISOString()
    const result = getHeartbeatHealth(old)
    expect(result.status).toBe('disconnected')
    expect(result.color).toBe('#ef4444')
  })

  it('respects custom thresholds', () => {
    const ts = new Date(Date.now() - 5000).toISOString()
    const result = getHeartbeatHealth(ts, { connected: 3000, stale: 8000 })
    expect(result.status).toBe('stale')
  })
})

describe('getTabletStatusSummary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns empty for null match', () => {
    const result = getTabletStatusSummary(null)
    expect(result.roles).toEqual([])
    expect(result.overallStatus).toBe('none')
    expect(result.expectedCount).toBe(0)
  })

  it('returns empty when no roles enabled', () => {
    const result = getTabletStatusSummary({
      refereeConnectionEnabled: false,
      homeTeamConnectionEnabled: false,
      awayTeamConnectionEnabled: false
    })
    expect(result.roles).toEqual([])
    expect(result.overallStatus).toBe('none')
  })

  it('returns ok when all enabled roles connected', () => {
    const now = new Date(Date.now() - 3000).toISOString()
    const result = getTabletStatusSummary({
      refereeConnectionEnabled: true,
      homeTeamConnectionEnabled: true,
      awayTeamConnectionEnabled: false,
      lastReferee1Heartbeat: now,
      lastHomeTeamHeartbeat: now
    })
    expect(result.roles).toHaveLength(2)
    expect(result.connectedCount).toBe(2)
    expect(result.expectedCount).toBe(2)
    expect(result.overallStatus).toBe('ok')
  })

  it('returns issues when a role is disconnected', () => {
    const now = new Date(Date.now() - 3000).toISOString()
    const result = getTabletStatusSummary({
      refereeConnectionEnabled: true,
      homeTeamConnectionEnabled: true,
      awayTeamConnectionEnabled: true,
      lastReferee1Heartbeat: now,
      lastHomeTeamHeartbeat: now,
      lastAwayTeamHeartbeat: null
    })
    expect(result.overallStatus).toBe('issues')
    expect(result.connectedCount).toBe(2)
    expect(result.expectedCount).toBe(3)
  })

  it('includes referee role with best of referee1/referee2 status', () => {
    const recent = new Date(Date.now() - 3000).toISOString()
    const stale = new Date(Date.now() - 20000).toISOString()
    const result = getTabletStatusSummary({
      refereeConnectionEnabled: true,
      homeTeamConnectionEnabled: false,
      awayTeamConnectionEnabled: false,
      lastReferee1Heartbeat: stale,
      lastReferee2Heartbeat: recent
    })
    expect(result.roles[0].status).toBe('connected')
  })
})

describe('formatAge', () => {
  it('returns "--" for null', () => {
    expect(formatAge(null)).toBe('--')
    expect(formatAge(undefined)).toBe('--')
  })

  it('returns "<1s" for very small values', () => {
    expect(formatAge(500)).toBe('<1s')
  })

  it('returns seconds for < 60s', () => {
    expect(formatAge(5000)).toBe('5s')
    expect(formatAge(45000)).toBe('45s')
  })

  it('returns minutes for >= 60s', () => {
    expect(formatAge(60000)).toBe('1m')
    expect(formatAge(300000)).toBe('5m')
  })
})
