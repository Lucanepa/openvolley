// The device's claim of a match on the venue relays (matchHandover
// scorerClaimOf / relaySyncDevice), against the real app database (Dexie 4
// on fake-indexeddb). 2026-10-26: a venue relay cannot ask a database which
// device scores a match; it tells the scorer from the device it left by the
// claim each sync carries, so a device must keep one claim per match until
// it continues the match again.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../db/db'
import { scorerClaimOf, relaySyncDevice } from '../matchHandover'

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

  it('no device id: no device; no match: the device alone', async () => {
    expect(await relaySyncDevice(db, 1, null)).toBeNull()
    expect(await relaySyncDevice(db, 999, DEVICE)).toEqual(DEVICE)
  })
})
