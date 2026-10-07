import { describe, it, expect } from 'vitest'
import {
  A3_LANDSCAPE_MM,
  PdfCheckError,
  SHEET_MM,
  SHEET_OFFSET_MM,
  assertCanvas,
  assertJpegDataUrl,
  assertValidPdf,
  assertVisibleSheet,
  isValidPdfBytes
} from '../pdfOutput'
import { generatedRemarks } from '../sheetRemarks'

const bytes = (s: string) => new TextEncoder().encode(s)
const pdf = (body = 'x'.repeat(30_000), end = '%%EOF\n') => bytes(`%PDF-1.3\n${body}\nstartxref\n123\n${end}`)

describe('PDF checks (field-spec 13.5)', () => {
  it('a valid PDF starts with %PDF- and ends with %%EOF', () => {
    expect(isValidPdfBytes(pdf())).toBe(true)
    expect(isValidPdfBytes(pdf().buffer)).toBe(true)
    expect(isValidPdfBytes(pdf('x'.repeat(30_000), '%%EOF\r\n  '))).toBe(true)
  })
  it('a cut-off, foreign or skeleton file is refused', () => {
    expect(isValidPdfBytes(pdf('x'.repeat(30_000), ''))).toBe(false)
    expect(isValidPdfBytes(bytes(`<html>${'x'.repeat(30_000)}%%EOF`))).toBe(false)
    // the 3 KB "PDF" of a hidden sheet (a page with a broken image)
    expect(isValidPdfBytes(pdf('x'.repeat(3000)))).toBe(false)
    expect(() => assertValidPdf(pdf('x'.repeat(3000)))).toThrow(PdfCheckError)
  })
  it('the capture must be the visible sheet, big enough, in its proportions', () => {
    expect(() => assertVisibleSheet({ offsetWidth: 0, offsetHeight: 0 })).toThrow(PdfCheckError) // display:none (LCS view)
    expect(() => assertVisibleSheet(null)).toThrow(PdfCheckError)
    expect(() => assertVisibleSheet({ offsetWidth: 1550, offsetHeight: 1085 })).not.toThrow()
    expect(() => assertCanvas({ width: 3100, height: 2170 })).not.toThrow()
    expect(() => assertCanvas({ width: 0, height: 0 })).toThrow(PdfCheckError)
    expect(() => assertCanvas({ width: 3100, height: 900 })).toThrow(PdfCheckError)
    expect(() => assertJpegDataUrl('data:,')).toThrow(PdfCheckError)
    expect(() => assertJpegDataUrl(`data:image/jpeg;base64,${'A'.repeat(20_000)}`)).not.toThrow()
  })
  it('the sheet is placed at its true size, centred on A3 (to scale, not stretched)', () => {
    expect(SHEET_OFFSET_MM.x * 2 + SHEET_MM.width).toBe(A3_LANDSCAPE_MM.width)
    expect(SHEET_OFFSET_MM.y * 2 + SHEET_MM.height).toBe(A3_LANDSCAPE_MM.height)
    expect(SHEET_OFFSET_MM).toEqual({ x: 5, y: 5 })
  })
})

describe('generated remarks: default / incomplete team (field-spec 8, 11)', () => {
  let seq = 0
  const ev = (type: string, setIndex: number, payload: Record<string, unknown>) => ({ type, setIndex, seq: ++seq, payload })

  it('a default before the start: the defaulting team, the reason and the awarded result', () => {
    seq = 0
    const events = [
      ...Array.from({ length: 25 }, () => ev('point', 1, { team: 'home', forfeitAwarded: true })),
      ev('forfait', 1, { team: 'away', reason: 'forfeit', scope: 'match', setIndex: 1 })
    ]
    const sets = [1, 2, 3].map(index => ({ index, homePoints: 25, awayPoints: 0, finished: true, forfeitCreated: index > 1 }))
    expect(generatedRemarks({ sets, events, teamAKey: 'home', bestOf: 5 }))
      .toEqual(['Team B declared in default, match result 3:0 (25:0, 25:0, 25:0).'])
  })

  it("the Scoreboard's reason 'forfait' (and any generic one) adds no bracket; a real reason does", () => {
    for (const [reason, tail] of [['forfait', ''], ['default', ''], ['no-show', ' (did not show up)'], ['bus broke down', ' (bus broke down)']]) {
      seq = 0
      const events = [
        ...Array.from({ length: 25 }, () => ev('point', 1, { team: 'home', forfeitAwarded: true })),
        ev('forfait', 1, { team: 'away', reason, scope: 'match', setIndex: 1 })
      ]
      const sets = [{ index: 1, homePoints: 25, awayPoints: 0, finished: true }]
      expect(generatedRemarks({ sets, events, teamAKey: 'home', bestOf: 5 }))
        .toEqual([`Team B declared in default${tail}, match result 1:0 (25:0).`])
    }
  })

  it('a default during the match: set, score at the forfeit (concerned team first), result', () => {
    seq = 0
    const events = [
      ...Array.from({ length: 10 }, () => ev('point', 2, { team: 'away' })),
      ...Array.from({ length: 14 }, () => ev('point', 2, { team: 'home' })),
      ...Array.from({ length: 11 }, () => ev('point', 2, { team: 'home', forfeitAwarded: true })),
      ev('forfait', 2, { team: 'away', reason: 'forfeit', scope: 'match', setIndex: 2 })
    ]
    const sets = [
      { index: 1, homePoints: 25, awayPoints: 20, finished: true },
      { index: 2, homePoints: 25, awayPoints: 10, finished: true },
      { index: 3, homePoints: 25, awayPoints: 0, finished: true, forfeitCreated: true }
    ]
    expect(generatedRemarks({ sets, events, teamAKey: 'away', bestOf: 5 })).toEqual([
      'Team A, Set 2, Result 10:14: declared in default. Match awarded to Team B, 3:0 (25:20, 25:10, 25:0).'
    ])
  })

  it('an incomplete team for one set', () => {
    seq = 0
    const events = [
      ...Array.from({ length: 12 }, () => ev('point', 2, { team: 'home' })),
      ...Array.from({ length: 16 }, () => ev('point', 2, { team: 'away' })),
      ...Array.from({ length: 9 }, () => ev('point', 2, { team: 'away', forfeitAwarded: true })),
      ev('forfait', 2, { team: 'home', reason: 'expulsion', scope: 'set', setIndex: 2 })
    ]
    const sets = [{ index: 2, homePoints: 12, awayPoints: 25, finished: true }]
    expect(generatedRemarks({ sets, events, teamAKey: 'home', bestOf: 5 })).toEqual([
      'Team A, Set 2, Result 12:16: incomplete team (expulsion). Set awarded to Team B, 25:12.'
    ])
  })

  it('nothing to say for a normal match', () => {
    expect(generatedRemarks({ sets: [], events: [], teamAKey: 'home' })).toEqual([])
  })
})
