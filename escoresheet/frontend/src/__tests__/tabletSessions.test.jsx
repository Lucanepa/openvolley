import { describe, it, expect, vi, beforeEach } from 'vitest'

const SEED = 'match_1791215210058_yxkc82'

const sync = vi.hoisted(() => ({
  validatePin: vi.fn(),
  validatePinSupabase: vi.fn()
}))

vi.mock('../utils/serverDataSync', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, validatePin: sync.validatePin, validatePinSupabase: sync.validatePinSupabase }
})

import { readBenchSession, validateBenchPin, benchGameLabel } from '../BenchApp'
import { revalidateRefereeSession } from '../RefereeApp'

beforeEach(() => {
  sync.validatePin.mockReset()
  sync.validatePinSupabase.mockReset()
  localStorage.clear()
})

describe('bench session (survives a reload)', () => {
  it('reads only a complete stored session', () => {
    expect(readBenchSession()).toBeNull()
    localStorage.setItem('bench_session', JSON.stringify({ matchId: SEED, team: 'home', pin: '372449' }))
    expect(readBenchSession()).toMatchObject({ matchId: SEED, team: 'home' })
    localStorage.setItem('bench_session', JSON.stringify({ matchId: SEED, team: 'left', pin: '372449' }))
    expect(readBenchSession()).toBeNull()
    localStorage.setItem('bench_session', '{broken')
    expect(readBenchSession()).toBeNull()
  })

  it('checks the PIN in the cloud first, then on the LAN relay', async () => {
    sync.validatePinSupabase.mockResolvedValue({ success: false, error: 'Invalid PIN code' })
    sync.validatePin.mockResolvedValue({ success: true, match: { id: SEED, homeTeamConnectionEnabled: true } })
    const r = await validateBenchPin('372449', 'home')
    expect(sync.validatePinSupabase).toHaveBeenCalledWith('372449', 'bench_home')
    expect(sync.validatePin).toHaveBeenCalledWith('372449', 'homeTeam')
    expect(r.match.id).toBe(SEED)
  })

  it('fills in the enabled flag an older cloud backend does not echo', async () => {
    sync.validatePinSupabase.mockResolvedValue({ success: true, match: { id: SEED } })
    const r = await validateBenchPin('372449', 'away')
    expect(r.match.awayTeamConnectionEnabled).toBe(true)
    expect(sync.validatePin).not.toHaveBeenCalled()
  })

  it('a restored session checks its PIN against its own match', async () => {
    sync.validatePinSupabase.mockResolvedValue({ success: true, match: { id: SEED, homeTeamConnectionEnabled: true } })
    await validateBenchPin('372449', 'home', { matchExternalId: SEED })
    expect(sync.validatePinSupabase).toHaveBeenCalledWith('372449', 'bench_home', { matchExternalId: SEED })
  })

  it('says rateLimited when a server refused to compare (429), not just a failed check', async () => {
    sync.validatePinSupabase.mockResolvedValue({ success: false, rateLimited: true, error: 'Too many failed attempts.' })
    sync.validatePin.mockRejectedValue(Object.assign(new Error('No match found with this PIN.'), { status: 404 }))
    expect(await validateBenchPin('372449', 'home')).toMatchObject({ success: false, rateLimited: true })
    sync.validatePinSupabase.mockResolvedValue({ success: false, error: 'Invalid PIN code' })
    sync.validatePin.mockRejectedValue(Object.assign(new Error('Too many failed attempts.'), { status: 429 }))
    expect(await validateBenchPin('372449', 'home')).toMatchObject({ success: false, rateLimited: true })
    // a wrong PIN is no rate limit
    sync.validatePin.mockRejectedValue(Object.assign(new Error('No match found with this PIN.'), { status: 404 }))
    expect((await validateBenchPin('372449', 'home')).rateLimited).toBeUndefined()
  })

  it('WebSocket mode never waits for the cloud', async () => {
    sync.validatePin.mockResolvedValue({ success: false })
    await validateBenchPin('372449', 'home', { connectionMode: 'websocket' })
    expect(sync.validatePinSupabase).not.toHaveBeenCalled()
  })
})

describe('referee session restore', () => {
  it('keeps seed-key ids as strings and accepts the cloud check', async () => {
    const cloud = vi.fn().mockResolvedValue({ success: true, match: { id: SEED } })
    const lan = vi.fn()
    expect(await revalidateRefereeSession(SEED, '314159', { checkCloud: cloud, checkLan: lan })).toEqual({ id: SEED })
    expect(lan).not.toHaveBeenCalled()
  })

  it('asks the backend about the stored match only', async () => {
    const cloud = vi.fn().mockResolvedValue({ success: true, match: { id: SEED } })
    await revalidateRefereeSession(SEED, '314159', { checkCloud: cloud, checkLan: vi.fn() })
    expect(cloud).toHaveBeenCalledWith('314159', 'referee', { matchExternalId: SEED })
  })

  it('a re-check refused for too many wrong PINs (429) keeps the stored PIN: it throws instead of answering null', async () => {
    const limited = vi.fn().mockResolvedValue({ success: false, rateLimited: true, error: 'Too many failed attempts.' })
    const lanLimited = vi.fn().mockRejectedValue(Object.assign(new Error('Too many failed attempts.'), { status: 429 }))
    await expect(revalidateRefereeSession(SEED, '314159', { checkCloud: limited, checkLan: lanLimited })).rejects.toMatchObject({ rateLimited: true })
    const lanWrong = vi.fn().mockRejectedValue(Object.assign(new Error('No match found with this PIN.'), { status: 404 }))
    await expect(revalidateRefereeSession(SEED, '314159', { checkCloud: limited, checkLan: lanWrong })).rejects.toMatchObject({ rateLimited: true })
  })

  it('no server reachable keeps the stored PIN too; a wrong PIN drops it (null)', async () => {
    const offline = vi.fn().mockResolvedValue({ success: false, error: 'Failed to fetch' })
    const lanOffline = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(revalidateRefereeSession(SEED, '314159', { checkCloud: offline, checkLan: lanOffline })).rejects.toThrow()
    const wrong = vi.fn().mockResolvedValue({ success: false, error: 'Invalid PIN code' })
    const lanWrong = vi.fn().mockRejectedValue(Object.assign(new Error('No match found with this PIN.'), { status: 404 }))
    expect(await revalidateRefereeSession(SEED, '314159', { checkCloud: wrong, checkLan: lanWrong })).toBeNull()
  })

  it('falls back to the LAN relay and refuses another match', async () => {
    const cloud = vi.fn().mockRejectedValue(new Error('offline'))
    const lan = vi.fn().mockResolvedValue({ success: true, match: { id: 7 } })
    expect(await revalidateRefereeSession('7', '314159', { checkCloud: cloud, checkLan: lan })).toEqual({ id: 7 })
    expect(await revalidateRefereeSession(SEED, '314159', { checkCloud: cloud, checkLan: lan })).toBeNull()
  })
})

describe('bench game label', () => {
  const t = (key) => (key === 'benchDashboard.game' ? 'Game' : key)
  it('shows the game number only when it is known', () => {
    expect(benchGameLabel(t, 12)).toBe('Game 12')
    expect(benchGameLabel(t, '999')).toBe('Game 999')
    expect(benchGameLabel(t, 0)).toBe('Game 0')
    expect(benchGameLabel(t, null)).toBeUndefined()
    expect(benchGameLabel(t, undefined)).toBeUndefined()
    expect(benchGameLabel(t, '')).toBeUndefined()
  })
})
