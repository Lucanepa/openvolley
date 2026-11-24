import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => [])
vi.mock('../activity/bus', () => ({ emitActivity: (kind, data, opts) => calls.push({ kind, data, opts }) }))

import { logScoresheetPdf, measuredTextZoom, pdfTimingText, PDF_LOG_KIND, PDF_LOG_LEVEL } from '../scoresheetPdfLog'
import { ACTIVITY_KINDS, sanitizeActivityData, activityLine, activityCategory } from '../../domain/activitySummary'

beforeEach(() => { calls.length = 0 })

describe('logScoresheetPdf', () => {
  it('writes a scoresheet.pdf entry with the level of its step', () => {
    logScoresheetPdf('received', { purpose: 'approval', attempt: 1, bytes: 51234, ms: 4200 }, { matchId: 7 })
    logScoresheetPdf('failed', { purpose: 'approval', attempt: 2, reason: 'closed' }, { matchId: 7 })
    logScoresheetPdf('approved_without_pdf', { purpose: 'approval', reason: 'closed' }, { matchId: 7 })
    expect(calls).toEqual([
      { kind: 'scoresheet.pdf', data: { step: 'received', purpose: 'approval', attempt: 1, bytes: 51234, ms: 4200 }, opts: { level: 'info', matchId: 7 } },
      { kind: 'scoresheet.pdf', data: { step: 'failed', purpose: 'approval', attempt: 2, reason: 'closed' }, opts: { level: 'warn', matchId: 7 } },
      { kind: 'scoresheet.pdf', data: { step: 'approved_without_pdf', purpose: 'approval', reason: 'closed' }, opts: { level: 'error', matchId: 7 } }
    ])
  })

  it('leaves out empty values and keys it does not know', () => {
    logScoresheetPdf('requested', { purpose: 'missing', attempt: 1, reason: null, bytes: undefined, filename: 'Home_vs_Away.pdf' })
    expect(calls[0].data).toEqual({ step: 'requested', purpose: 'missing', attempt: 1 })
    expect(calls[0].opts).toEqual({ level: 'info' })
  })

  it('is a known activity kind whose data survives the sanitizer (no personal data)', () => {
    expect(ACTIVITY_KINDS[PDF_LOG_KIND]).toBeTruthy()
    const data = { step: 'failed', purpose: 'approval', attempt: 2, reason: 'stalled', ms: 20000, team: 'Home V', email: 'a@b.ch' }
    expect(sanitizeActivityData(PDF_LOG_KIND, data)).toEqual({ step: 'failed', purpose: 'approval', attempt: 2, reason: 'stalled', ms: 20000 })
    expect(activityCategory(PDF_LOG_KIND, 'info')).toBe('match')
    expect(activityCategory(PDF_LOG_KIND, PDF_LOG_LEVEL.approved_without_pdf)).toBe('error')
  })

  it('reads as one line in the activity list', () => {
    expect(activityLine({ kind: 'scoresheet.pdf', data: { step: 'failed', purpose: 'approval', attempt: 2, reason: 'closed', ms: 900 } }))
      .toBe('failed · approval · closed · attempt 2 · 900 ms')
    expect(activityLine({ kind: 'scoresheet.pdf', data: { step: 'received', purpose: 'approval', attempt: 1, bytes: 8 } }))
      .toBe('received · approval · 8 bytes')
  })
})

// Perf pass 22.11.2026: where the approval PDF's time went on the tablet, in
// the catalog as it is (the server's and OpenBeach's copies must match it)
describe('the PDF timing entry', () => {
  const heard = {
    loading: { at: 900 },
    capture: { at: 12400, ms: 3101.4 },
    styles: { at: 31000, ms: 2003.2 },
    canvas: { at: 31010, ms: 26104.8 },
    jpeg: { at: 41500, ms: 905 },
    pdf: { at: 43000, ms: 1210 }
  }

  it('is numbers only, key=value, under the 200 characters an entry keeps', () => {
    const text = pdfTimingText(heard, 43300, { events: 1032, dpr: 1.3312, zoom: 1.3 })
    expect(text).toBe('load=12400 capture=30900 page=3101 styles=2003 canvas=26105 jpeg=905 pdf=1210 events=1032 dpr=1.33 zoom=1.3')
    expect(text.length).toBeLessThan(200)
    // no long digit run a support report would take for a PIN
    expect(text).not.toMatch(/\d(?:[\s-]?\d){5,}/)
  })

  it('names what it heard: a retry, and nothing for steps that never came', () => {
    expect(pdfTimingText({ capture: { at: 500 }, retry: { at: 9000, ms: 7000 } }, 20000, { events: 0, dpr: 2, zoom: null }))
      .toBe('load=500 capture=19500 retry=7000 events=0 dpr=2')
    expect(pdfTimingText({}, 1000)).toBe('')
  })

  it('is an info entry whose data survives the sanitizer and reads as one line', () => {
    logScoresheetPdf('timing', { purpose: 'approval', attempt: 1, reason: pdfTimingText(heard, 43300, { events: 1032, dpr: 1.5, zoom: 1 }), ms: 43300 }, { matchId: 7 })
    expect(calls[0].opts).toEqual({ level: 'info', matchId: 7 })
    expect(sanitizeActivityData(PDF_LOG_KIND, calls[0].data)).toEqual(calls[0].data)
    expect(activityLine({ kind: PDF_LOG_KIND, data: calls[0].data }))
      .toBe('timing · approval · load=12400 capture=30900 page=3101 styles=2003 canvas=26105 jpeg=905 pdf=1210 events=1032 dpr=1.5 zoom=1 · 43300 ms')
    expect(PDF_LOG_LEVEL.timing).toBe('info')
  })

  it('measures the text zoom from a 100px span, and leaves nothing behind', () => {
    const before = document.body.childElementCount
    expect(measuredTextZoom(document)).toBe(1)
    expect(document.body.childElementCount).toBe(before)
    expect(measuredTextZoom(null)).toBeNull()
  })
})
