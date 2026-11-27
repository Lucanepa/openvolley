import { describe, it, expect, vi, beforeEach } from 'vitest'

const emitActivity = vi.fn()
vi.mock('../../activity/bus', () => ({ emitActivity: (...args) => emitActivity(...args) }))

import { photoReadData, logPhotoRead, PHOTO_READ_KIND } from '../photoReadLog'
import { ACTIVITY_KINDS, sanitizeActivityData } from '../../../domain/activitySummary'
import { importedRosterOf } from '../../../domain/importedRoster'

// Made-up people
const roster = () => importedRosterOf({
  players: [
    { number: 4, licence: '654321', firstName: 'Mia', lastName: 'Beispiel', confidence: { number: 0.95, licence: 0.96, firstName: 0.95, lastName: 0.95 } },
    { number: 4, licence: '654322', firstName: 'Lou', lastName: 'Exempel', confidence: { number: 0.95, licence: 0.96, firstName: 0.95, lastName: 0.3 } },
    { number: 9, licence: '', firstName: 'Ida', lastName: 'Muster', confidence: { number: 0.95, firstName: 0.95, lastName: 0.95 } }
  ],
  coach: { firstName: 'Hans', lastName: 'Probst', licence: '10001' }
}, 'ocr')
const nav = { hardwareConcurrency: 8, deviceMemory: 4 }

beforeEach(() => emitActivity.mockReset())

describe('photoReadLog (photo.read)', () => {
  it('a reading that worked: its time and counts, nothing read from the photo', () => {
    const shown = { ...roster(), struck: [{ firstName: 'Rita', lastName: 'Vorbild', licence: '654329' }] }
    const stats = { workers: 3, turned: true, msEngine: 412.6, msPage: 7903, msHand: 1188, marksBy: 'onnx' }
    const data = photoReadData({ ms: 11384.4, outcome: 'ok', roster: shown, stats, lang: 'fr', nav })
    // 4 twice (red, both), a last name unsure and a licence missing (amber); the rest of the time
    // (the photo made flat, the SV numbers and struck rows read again): 11384 - 413 - 7903 - 1188
    expect(data).toEqual({ ms: 11384, outcome: 'ok', rows: 3, toCheck: 4, struck: 1, cores: 8, memory: 4, workers: 3, turned: true, msEngine: 413, msPage: 7903, msHand: 1188, msRest: 1880, marksBy: 'onnx', lang: 'fr' })
    expect(Object.keys(data).every((k) => ACTIVITY_KINDS[PHOTO_READ_KIND].keys.includes(k))).toBe(true)
    // the sanitizers keep all of it as it is
    expect(sanitizeActivityData(PHOTO_READ_KIND, data)).toEqual(data)
    const json = JSON.stringify(data)
    for (const s of ['Beispiel', 'Exempel', 'Muster', 'Probst', 'Vorbild', 'Mia', 'Rita', '6543', '10001']) expect(json).not.toContain(s)
  })

  it('a failure: the code shown (another code as "other"), no counts of rows; a device that does not say its memory', () => {
    expect(photoReadData({ ms: 8150, outcome: 'ocr-blurry', stats: { workers: 1, msEngine: 30, msPage: 7000, msHand: 0, marksBy: 'tesseract' }, lang: 'de', nav: { hardwareConcurrency: 4 } }))
      .toEqual({ ms: 8150, outcome: 'ocr-blurry', cores: 4, memory: null, workers: 1, turned: false, msEngine: 30, msPage: 7000, msHand: 0, msRest: 1120, marksBy: 'tesseract', lang: 'de' })
    expect(photoReadData({ ms: 10, outcome: 'Muster Hans', nav: {} }).outcome).toBe('other')
    // nothing noted (it failed before it started): zeros, the marks by Tesseract, all three languages
    expect(photoReadData({ ms: -5, outcome: 'ocr-load', nav: {} })).toEqual({ ms: 0, outcome: 'ocr-load', cores: null, memory: null, workers: 0, turned: false, msEngine: 0, msPage: 0, msHand: 0, msRest: 0, marksBy: 'tesseract', lang: 'other' })
    // a stage longer than the whole (clocks apart): the rest is never negative; unknown values fall back
    const odd = photoReadData({ ms: 100, outcome: 'ok', roster: roster(), stats: { msEngine: 80, msPage: 90, msHand: -4, marksBy: 'Muster' }, lang: 'Hans', nav: {} })
    expect([odd.msRest, odd.msHand, odd.marksBy, odd.lang]).toEqual([0, 0, 'tesseract', 'other'])
  })

  it('one entry per reading, a failure as a warning; never throws', () => {
    logPhotoRead({ ms: 9000, outcome: 'ok', roster: roster(), stats: { workers: 2 }, nav })
    logPhotoRead({ ms: 9000, outcome: 'ocr-timeout', nav })
    expect(emitActivity).toHaveBeenCalledTimes(2)
    expect(emitActivity.mock.calls[0][0]).toBe('photo.read')
    expect(emitActivity.mock.calls[0][2]).toEqual({ level: 'info' })
    expect(emitActivity.mock.calls[1][1].outcome).toBe('ocr-timeout')
    expect(emitActivity.mock.calls[1][2]).toEqual({ level: 'warn' })
    // a device whose navigator throws: nothing logged, the import goes on
    const broken = { get hardwareConcurrency () { throw new Error('denied') } }
    expect(() => logPhotoRead({ ms: 1, outcome: 'ok', roster: roster(), nav: broken })).not.toThrow()
    expect(emitActivity).toHaveBeenCalledTimes(2)
  })
})
