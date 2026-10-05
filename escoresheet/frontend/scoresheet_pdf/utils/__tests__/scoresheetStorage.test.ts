import { describe, it, expect } from 'vitest'
import { finalScoresheetPath, finalScoresheetUrl, describeScoresheetLoadError } from '../scoresheetStorage'

describe('finalScoresheetPath / finalScoresheetUrl', () => {
  it('builds the path scoresheetUploader writes ({UTC date}/game{n}_final.json)', () => {
    expect(finalScoresheetPath('2026-10-05', 991404)).toBe('2026-10-05/game991404_final.json')
  })

  it('links a final match to the viewer by the UTC date of scheduled_at and game_n', () => {
    expect(finalScoresheetUrl({ status: 'final', game_n: 991404, scheduled_at: '2026-10-05T18:00:00Z' }))
      .toBe('/scoresheet/?date=2026-10-05&game=991404')
    // 00:30 in Zurich is still the previous day in UTC: the uploader used UTC too
    expect(finalScoresheetUrl({ status: 'final', game_n: 7, scheduled_at: '2026-10-06T00:30:00+02:00' }))
      .toBe('/scoresheet/?date=2026-10-05&game=7')
  })

  it('no link for a match that is not final or cannot be located', () => {
    expect(finalScoresheetUrl({ status: 'live', game_n: 1, scheduled_at: '2026-10-05T18:00:00Z' })).toBe(null)
    expect(finalScoresheetUrl({ status: 'final', game_n: null, scheduled_at: '2026-10-05T18:00:00Z' })).toBe(null)
    expect(finalScoresheetUrl({ status: 'final', game_n: 1, scheduled_at: null })).toBe(null)
    expect(finalScoresheetUrl({ status: 'final', game_n: 1, scheduled_at: 'not a date' })).toBe(null)
    expect(finalScoresheetUrl(null)).toBe(null)
  })
})

describe('describeScoresheetLoadError', () => {
  const p = '2026-10-05/game1_final.json'
  it('tells sign-in required, another account, missing and offline apart', () => {
    expect(describeScoresheetLoadError({ status: 401, code: 'missing_token' }, p).kind).toBe('signin')
    expect(describeScoresheetLoadError({ status: 403, code: 'OV_STORAGE_FORBIDDEN' }, p).kind).toBe('forbidden')
    // the backend answers a missing object with 200 + OV_STORAGE_NOT_FOUND
    const missing = describeScoresheetLoadError({ status: 200, code: 'OV_STORAGE_NOT_FOUND' }, p)
    expect(missing).toMatchObject({ kind: 'notfound', title: 'Scoresheet Not Found' })
    expect(missing.message).toContain(p)
    expect(describeScoresheetLoadError({ status: 0, network: true, message: 'Failed to fetch' }, p).kind).toBe('offline')
    expect(describeScoresheetLoadError({ status: 500, message: 'Storage operation failed' }, p)).toMatchObject({ kind: 'error', message: 'Storage operation failed' })
    expect(describeScoresheetLoadError(null, p).kind).toBe('error')
  })
})
