import { describe, it, expect, beforeEach } from 'vitest'
import { getScoresheetKey } from '../scoresheetKey'
import { scoresheetUploadPath } from '../scoresheetUploader'
import { SCORESHEET_KEY_RE } from '../../../scoresheet_pdf/utils/scoresheetStorage'

describe('scoresheet key and upload path', () => {
  beforeEach(() => {
    try { localStorage.clear() } catch { /* no storage */ }
  })

  it('one random key per match, stable across calls, kept off the match record', () => {
    const match = { id: 3, seed_key: 'seed-abc', gameNumber: '991404', scheduledAt: '2026-10-05T18:00:00Z' }
    const k1 = getScoresheetKey(match)
    expect(k1).toMatch(SCORESHEET_KEY_RE)
    expect(getScoresheetKey({ ...match })).toBe(k1)
    expect(getScoresheetKey({ id: 4, seed_key: 'seed-other' })).not.toBe(k1)
    expect(match).not.toHaveProperty('scoresheetKey')
  })

  it('all files of a match share the key; no game number or id, no upload path (no shared "unknown")', () => {
    const match = { id: 5, externalId: 'ext-5', scheduledAt: '2026-10-05T18:00:00Z' }
    const json = scoresheetUploadPath(match)
    const final = scoresheetUploadPath(match, { final: true })
    const pdf = scoresheetUploadPath(match, { ext: 'pdf' })
    expect(json).toMatch(/^2026-10-05\/gameext-5_k[0-9a-f]{32}\.json$/)
    expect(final).toBe(json.replace('.json', '_final.json'))
    expect(pdf).toBe(json.replace('.json', '.pdf'))
    expect(scoresheetUploadPath({ id: 6, scheduledAt: '2026-10-05T18:00:00Z' })).toBe(null)
  })
})
