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

  it('a check refused for too many wrong PINs (429) is "rate-limited", not a wrong PIN', async () => {
    const limitedCloud = vi.fn().mockResolvedValue({ success: false, rateLimited: true, error: 'Too many failed attempts. Please wait 10 minutes before trying again.' })
    expect(await validateRefereePin('372449', { checkCloud: limitedCloud, checkLan: relayNoMatch }))
      .toEqual({ match: null, reason: 'rate-limited' })
    const cloudWrong = vi.fn().mockResolvedValue({ success: false, error: 'Invalid PIN code' })
    const limitedLan = vi.fn().mockRejectedValue(Object.assign(new Error('Too many failed attempts.'), { status: 429 }))
    expect(await validateRefereePin('372449', { checkCloud: cloudWrong, checkLan: limitedLan }))
      .toEqual({ match: null, reason: 'rate-limited' })
  })

  it('a throwing cloud check still reaches the relay', async () => {
    const checkCloud = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const checkLan = vi.fn().mockResolvedValue({ success: true, match: { id: SEED } })
    expect((await validateRefereePin('372449', { checkCloud, checkLan })).source).toBe('websocket')
  })

  // 2026-10-26: 20 wrong referee PINs in one hall (one venue address) for
  // other matches made a new referee with the right PIN wait 10 minutes
  it('a page that knows the match checks the PIN against it only', async () => {
    const checkCloud = vi.fn().mockResolvedValue({ success: true, match: { id: SEED } })
    const r = await validateRefereePin('372449', { checkCloud, checkLan: relayNoMatch, matchExternalId: SEED })
    expect(r).toMatchObject({ match: { id: SEED }, source: 'supabase' })
    expect(checkCloud).toHaveBeenCalledWith('372449', 'referee', { matchExternalId: SEED })
  })

  // 2026-11 audit: the relay compared the PIN with every match it holds, so
  // the tablet opened another hall's match whose referee PIN was the same
  it('asks the relay for the picked match, and refuses its answer for another match', async () => {
    const OTHER = 'match_1791215210099_other1'
    const checkCloud = vi.fn().mockResolvedValue({ success: false, error: 'Invalid PIN code' })
    const checkLan = vi.fn().mockResolvedValue({ success: true, match: { id: SEED } })
    expect(await validateRefereePin('372449', { checkCloud, checkLan, matchExternalId: SEED })).toMatchObject({ match: { id: SEED }, source: 'websocket' })
    expect(checkLan).toHaveBeenCalledWith('372449', 'referee', { matchId: SEED })
    const otherLan = vi.fn().mockResolvedValue({ success: true, match: { id: OTHER } })
    expect(await validateRefereePin('372449', { checkCloud, checkLan: otherLan, matchExternalId: SEED })).toEqual({ match: null, reason: 'invalid' })
    // no match picked: the game number chosen, if any
    await validateRefereePin('372449', { checkCloud, checkLan, gameNumber: '12' })
    expect(checkLan).toHaveBeenLastCalledWith('372449', 'referee', { gameNumber: '12' })
  })

  // review of the 2026-11 fix: with only a game number picked (two listed
  // matches share it, a numeric LAN id) the cloud and relay answers were
  // taken whatever game they were for
  it('with only a game number picked, an answer for another game number is refused', async () => {
    const other = { id: 'match_1791215210099_other1', gameNumber: 13 }
    const cloudOther = vi.fn().mockResolvedValue({ success: true, match: other })
    const lanOther = vi.fn().mockResolvedValue({ success: true, match: other })
    expect(await validateRefereePin('372449', { checkCloud: cloudOther, checkLan: lanOther, gameNumber: '12' })).toEqual({ match: null, reason: 'invalid' })
    const lanRight = vi.fn().mockResolvedValue({ success: true, match: { id: SEED, gameNumber: 12 } })
    expect(await validateRefereePin('372449', { checkCloud: cloudOther, checkLan: lanRight, gameNumber: '12' })).toMatchObject({ match: { id: SEED }, source: 'websocket' })
    // a picked key decides; an answer without a game number is not compared
    const cloudKey = vi.fn().mockResolvedValue({ success: true, match: { id: SEED, gameNumber: 'match_1791215210058' } })
    expect((await validateRefereePin('372449', { checkCloud: cloudKey, checkLan: lanOther, matchExternalId: SEED, gameNumber: '12' })).source).toBe('supabase')
    const noNumber = vi.fn().mockResolvedValue({ success: true, match: { id: SEED } })
    expect((await validateRefereePin('372449', { checkCloud: noNumber, checkLan: lanOther, gameNumber: '12' })).source).toBe('supabase')
  })

  it('a PIN the relay finds in more than one match asks for the game (409)', async () => {
    const checkCloud = vi.fn().mockResolvedValue({ success: false, error: 'Invalid PIN code' })
    const checkLan = vi.fn().mockRejectedValue(Object.assign(new Error('More than one match has this PIN.'), { status: 409 }))
    expect(await validateRefereePin('372449', { checkCloud, checkLan })).toEqual({ match: null, reason: 'ambiguous' })
  })
})
