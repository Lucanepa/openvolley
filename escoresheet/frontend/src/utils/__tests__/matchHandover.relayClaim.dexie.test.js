// The device's claim of a match on the venue relays (matchHandover
// scorerClaimOf / relaySyncDevice), against the real app database (Dexie 4
// on fake-indexeddb). 2026-10-26: a venue relay cannot ask a database which
// device scores a match; it tells the scorer from the device it left by the
// claim each sync carries, so a device must keep one claim per match until
// it continues the match again.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../db/db'
import { scorerClaimOf, relaySyncDevice, supersededClaimsOf } from '../matchHandover'

const DEVICE = { id: '00000000-0000-4000-8000-000000000001', platform: 'web' }

beforeEach(async () => {
  await db.matches.clear()
})

describe('the claim of a match on the venue relays', () => {
  it('is made once and kept: the scoreboard\'s and the app\'s syncs at once never make two', async () => {
    const id = await db.matches.add({ seed_key: 'match_1_a', status: 'live' })
    const claims = await Promise.all([scorerClaimOf(db, id), scorerClaimOf(db, id), relaySyncDevice(db, id, DEVICE)])
    expect(claims[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(claims[1]).toBe(claims[0])
    expect(claims[2]).toEqual({ ...DEVICE, claim: claims[0] })
    expect((await db.matches.get(id)).scorerClaim).toBe(claims[0])
    expect(await scorerClaimOf(db, id)).toBe(claims[0])
  })

  it('a match continued here again (a restore cleared it, an import is a new row) gets a new one', async () => {
    const id = await db.matches.add({ seed_key: 'match_1_a', status: 'live' })
    const first = await scorerClaimOf(db, id)
    await db.matches.update(id, { scorerClaim: null })
    const again = await scorerClaimOf(db, id)
    expect(again).toBeTruthy()
    expect(again).not.toBe(first)
    const imported = await db.matches.add({ seed_key: 'match_1_a', status: 'live' })
    expect(await scorerClaimOf(db, imported)).not.toBe(again)
  })

  // 2026-10-27: after a restart a venue relay no longer knew which device
  // took the room over from which; a match continued from a backup names the
  // file's claims with every sync, so the relay refuses those older copies
  it('a match continued from a backup names the claims of the copies it was continued from', async () => {
    const id = await db.matches.add({ seed_key: 'match_1_a', status: 'live', supersededClaims: ['phone-1', 'laptop-1'] })
    const device = await relaySyncDevice(db, id, DEVICE)
    expect(device).toEqual({ ...DEVICE, claim: expect.stringMatching(/^[0-9a-f-]{36}$/), supersedes: ['phone-1', 'laptop-1'] })
    expect(supersededClaimsOf({ scorerClaim: 'tablet-1', supersededClaims: device.supersedes })).toEqual(['tablet-1', 'phone-1', 'laptop-1'])
    expect(supersededClaimsOf({ scorerClaim: 'x', supersededClaims: Array.from({ length: 20 }, (_, i) => `c-${i}`) })).toHaveLength(8)
    expect(supersededClaimsOf(null)).toEqual([])
    // none: the claim alone, as before
    const plain = await db.matches.add({ seed_key: 'match_1_b', status: 'live' })
    expect(Object.keys(await relaySyncDevice(db, plain, DEVICE)).sort()).toEqual(['claim', 'id', 'platform'])
  })

  it('no device id: no device; no match: the device alone', async () => {
    expect(await relaySyncDevice(db, 1, null)).toBeNull()
    expect(await relaySyncDevice(db, 999, DEVICE)).toEqual(DEVICE)
  })
})
