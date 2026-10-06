import { describe, it, expect, vi } from 'vitest'
import { validateRefereePin } from '../RefereeApp'

const SEED = 'match_1791215210058_yxkc82'
const relayNoMatch = () => Promise.reject(new Error('No match found with this PIN. Make sure the main scoresheet is running and connected.'))

describe('referee PIN check', () => {
  it('accepts the cloud check without asking the relay', async () => {
    const checkCloud = vi.fn().mockResolvedValue({ success: true, match: { id: SEED } })
    const checkLan = vi.fn()
    const r = await validateRefereePin('372449', { checkCloud, checkLan })
    expect(r).toMatchObject({ match: { id: SEED }, source: 'supabase' })
    expect(checkCloud).toHaveBeenCalledWith('372449', 'referee')
    expect(checkLan).not.toHaveBeenCalled()
  })

  it('falls back to the relay for a relay-only match', async () => {
    const checkCloud = vi.fn().mockResolvedValue({ success: false, error: 'Invalid PIN code' })
    const checkLan = vi.fn().mockResolvedValue({ success: true, match: { id: SEED } })
    const r = await validateRefereePin('372449', { checkCloud, checkLan })
    expect(r).toMatchObject({ match: { id: SEED }, source: 'websocket' })
  })

  it('a wrong PIN is "invalid", not the relay\'s "make sure the scoresheet is running"', async () => {
    const checkCloud = vi.fn().mockResolvedValue({ success: false, error: 'Invalid PIN code' })
    const r = await validateRefereePin('123457', { checkCloud, checkLan: relayNoMatch })
    expect(r).toEqual({ match: null, reason: 'invalid' })
  })

  it('reports "unreachable" only when neither server answered', async () => {
    const offlineCloud = vi.fn().mockResolvedValue({ success: false, error: 'Failed to fetch' })
    const offlineLan = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await validateRefereePin('123457', { checkCloud: offlineCloud, checkLan: offlineLan }))
      .toEqual({ match: null, reason: 'unreachable' })

    const timedOut = vi.fn().mockResolvedValue({ success: false, error: 'Server PIN check timed out' })
    expect(await validateRefereePin('123457', { checkCloud: timedOut, checkLan: relayNoMatch }))
      .toEqual({ match: null, reason: 'invalid' })
  })

  it('a throwing cloud check still reaches the relay', async () => {
    const checkCloud = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const checkLan = vi.fn().mockResolvedValue({ success: true, match: { id: SEED } })
    expect((await validateRefereePin('372449', { checkCloud, checkLan })).source).toBe('websocket')
  })
})
