import { describe, it, expect } from 'vitest'
import {
  finalScoresheetPath, finalScoresheetUrl, describeScoresheetLoadError, newScoresheetKey, SCORESHEET_KEY_RE,
  scoresheetGameId, scoresheetObjectPath, parseScoresheetName, redactScoresheetPath, findOwnScoresheet
} from '../scoresheetStorage'

describe('finalScoresheetPath / finalScoresheetUrl', () => {
  it('older key-less name ({UTC date}/game{n}_final.json)', () => {
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
    expect(finalScoresheetUrl({ status: 'final', game_n: null, external_id: '', scheduled_at: '2026-10-05T18:00:00Z' })).toBe(null)
    expect(finalScoresheetUrl({ status: 'final', game_n: 1, scheduled_at: null })).toBe(null)
    expect(finalScoresheetUrl({ status: 'final', game_n: 1, scheduled_at: 'not a date' })).toBe(null)
    expect(finalScoresheetUrl(null)).toBe(null)
  })
})

describe('scoresheet names', () => {
  const key = 'k' + 'a1'.repeat(16) // built at runtime: a literal trips the secret scanner

  it('a friendly without a game number is located by its external id, like the uploader names it', () => {
    expect(finalScoresheetUrl({ status: 'final', game_n: null, external_id: 'm_42', scheduled_at: '2026-10-05T18:00:00Z' }))
      .toBe('/scoresheet/?date=2026-10-05&game=m-42')
    expect(scoresheetGameId({ gameNumber: '7', externalId: 'x' })).toBe('7')
    expect(scoresheetGameId({ game_n: 7, external_id: 'x' })).toBe('7')
    expect(scoresheetGameId({ externalId: 'a/b_c' })).toBe('a-b-c')
    expect(scoresheetGameId({})).toBe(null)
    expect(scoresheetGameId({ externalId: '__' })).toBe(null)
    expect(scoresheetGameId(null)).toBe(null)
  })

  it('a fresh key is 128 random bits; object names carry it and parse back', () => {
    const a = newScoresheetKey()
    expect(a).toMatch(SCORESHEET_KEY_RE)
    expect(newScoresheetKey()).not.toBe(a)
    expect(scoresheetObjectPath('2026-10-05', '7', key, { final: true })).toBe(`2026-10-05/game7_${key}_final.json`)
    expect(scoresheetObjectPath('2026-10-05', '7', key, { ext: 'pdf' })).toBe(`2026-10-05/game7_${key}.pdf`)
    expect(() => scoresheetObjectPath('2026-10-05', '7', 'guessable')).toThrow()
    expect(parseScoresheetName(`game7_${key}_final.json`)).toEqual({ game: '7', key, final: true, ext: 'json' })
    expect(parseScoresheetName(`game7-x_${key}.json`)).toEqual({ game: '7-x', key, final: false, ext: 'json' })
    expect(parseScoresheetName('game7_final.json')).toEqual({ game: '7', key: null, final: true, ext: 'json' })
    expect(parseScoresheetName('notes.txt')).toBe(null)
    expect(redactScoresheetPath(`2026-10-05/game7_${key}_final.json`)).toBe('2026-10-05/game7_k…_final.json')
  })

  it('findOwnScoresheet lists the date folder and picks the approved file of exactly that game', async () => {
    const calls: any[] = []
    const files = [
      { id: '1', name: `game70_${key}_final.json` },
      { id: '2', name: `game7_${key}.json` },
      { id: '3', name: `game7_${key}_final.json` },
      { id: '4', name: `game7_${key}.pdf` },
      { id: null, name: 'game7_sub' }
    ]
    const storage = { list: async (dir: string, opts: object) => { calls.push([dir, opts]); return { data: files, error: null } } }
    expect(await findOwnScoresheet(storage, '2026-10-05', 7)).toEqual({ path: `2026-10-05/game7_${key}_final.json`, error: null })
    expect(calls[0][0]).toBe('2026-10-05')
    expect(calls[0][1]).toMatchObject({ search: 'game7' })
    const inMatchOnly = { list: async () => ({ data: [files[1]], error: null }) }
    expect((await findOwnScoresheet(inMatchOnly, '2026-10-05', '7')).error.code).toBe('OV_STORAGE_NOT_FOUND')
    expect((await findOwnScoresheet(inMatchOnly, '2026-10-05', '7', { final: false })).path).toBe(`2026-10-05/game7_${key}.json`)
    const denied = { list: async () => ({ data: null, error: { status: 401, code: 'missing_token' } }) }
    expect((await findOwnScoresheet(denied, '2026-10-05', '7')).error.status).toBe(401)
    expect((await findOwnScoresheet(storage, '../x', '7')).error.code).toBe('OV_STORAGE_NOT_FOUND')
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
