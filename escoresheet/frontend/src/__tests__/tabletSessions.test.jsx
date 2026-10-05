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

import { readBenchSession, validateBenchPin } from '../BenchApp'
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

  it('falls back to the LAN relay and refuses another match', async () => {
    const cloud = vi.fn().mockRejectedValue(new Error('offline'))
    const lan = vi.fn().mockResolvedValue({ success: true, match: { id: 7 } })
    expect(await revalidateRefereeSession('7', '314159', { checkCloud: cloud, checkLan: lan })).toEqual({ id: 7 })
    expect(await revalidateRefereeSession(SEED, '314159', { checkCloud: cloud, checkLan: lan })).toBeNull()
  })
})
