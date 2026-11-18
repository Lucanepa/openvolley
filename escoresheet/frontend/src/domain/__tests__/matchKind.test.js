import { describe, it, expect } from 'vitest'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { isLocalOnly } from '../matchKind'
import { upgradeGlobalMatches } from '../../utils/globalCloud'

describe('isLocalOnly (never in the cloud database)', () => {
  it('a test, easy or Global match stays local; an official match does not', () => {
    expect(isLocalOnly({ test: true })).toBe(true)
    expect(isLocalOnly({ test: true, easy: true })).toBe(true)
    expect(isLocalOnly({ test: false, global: true })).toBe(true)
    expect(isLocalOnly({ global: true })).toBe(true)
    expect(isLocalOnly({ test: false, seed_key: 'game-1' })).toBe(false)
    expect(isLocalOnly({})).toBe(false)
    expect(isLocalOnly(null)).toBe(false)
    expect(isLocalOnly(undefined)).toBe(false)
  })
})

describe('upgradeGlobalMatches', () => {
  it('drops the test flag of a Global match made before 2026-11-17, and only of those', async () => {
    const database = new Dexie(`matchKind-${Math.random()}`)
    database.version(1).stores({ matches: '++id' })
    await database.matches.bulkAdd([
      { global: true, test: true },
      { test: true },
      { global: true, test: false },
      { test: false }
    ])
    expect(await upgradeGlobalMatches(database)).toBe(1)
    const rows = await database.matches.toArray()
    expect(rows.map(r => r.test)).toEqual([false, true, false, false])
    expect(rows.every(r => r.global !== true || isLocalOnly(r))).toBe(true)
    database.close()
  })
})
