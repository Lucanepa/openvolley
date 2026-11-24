import { describe, it, expect } from 'vitest'
import Dexie from 'dexie'
import { freeStorageBytes, isStorageFullError, LOW_STORAGE_BYTES } from '../storageSpace'

describe('isStorageFullError', () => {
  it('is the quota error itself, or inside the AbortError Dexie throws for its transaction', () => {
    const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    expect(isStorageFullError(quota)).toBe(true)
    // what a scoring tap got in the stress test (2026-10-25): name AbortError,
    // message 'QuotaExceededError', inner.name 'QuotaExceededError'
    const abort = new Dexie.AbortError('QuotaExceededError', quota)
    expect(abort.name).toBe('AbortError')
    expect(isStorageFullError(abort)).toBe(true)
    expect(isStorageFullError(new Dexie.QuotaExceededError('full'))).toBe(true)
    expect(isStorageFullError({ name: 'AbortError', inner: { name: 'QuotaExceededError' } })).toBe(true)
    expect(isStorageFullError({ name: 'Error', cause: { inner: { name: 'QuotaExceededError' } } })).toBe(true)
  })

  it('is not any other failure', () => {
    expect(isStorageFullError(new Dexie.AbortError('Transaction aborted'))).toBe(false)
    expect(isStorageFullError(new Dexie.ConstraintError('Key already exists'))).toBe(false)
    expect(isStorageFullError(new Error('boom'))).toBe(false)
    expect(isStorageFullError(null)).toBe(false)
    expect(isStorageFullError('QuotaExceededError')).toBe(false)
    const loop = { name: 'AbortError' }
    loop.inner = loop
    expect(isStorageFullError(loop)).toBe(false)
  })
})

describe('freeStorageBytes', () => {
  const nav = (estimate) => ({ storage: { estimate } })

  it('is what is left of the quota', async () => {
    expect(await freeStorageBytes(nav(async () => ({ usage: 30e6, quota: 50e6 })))).toBe(20e6)
    expect(await freeStorageBytes(nav(async () => ({ usage: 60e6, quota: 50e6 })))).toBe(0)
  })

  it('is null when the browser cannot say', async () => {
    expect(await freeStorageBytes({})).toBe(null)
    expect(await freeStorageBytes(undefined)).toBe(null)
    expect(await freeStorageBytes(nav(async () => ({ usage: 1 })))).toBe(null)
    expect(await freeStorageBytes(nav(async () => { throw new Error('denied') }))).toBe(null)
  })

  it('warns with room for a few matches left', () => {
    // a 5-set match writes a few MB (events with their state snapshots)
    expect(LOW_STORAGE_BYTES).toBeGreaterThanOrEqual(20 * 1024 * 1024)
  })
})
