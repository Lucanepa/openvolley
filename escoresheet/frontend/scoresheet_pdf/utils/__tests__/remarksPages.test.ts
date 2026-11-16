import { describe, it, expect } from 'vitest'
import { jsPDF } from 'jspdf'
import { REMARKS_PAGE, remarksPageLines, writeRemarksPages } from '../remarksPages'
import { A3_LANDSCAPE_MM } from '../pdfOutput'

// field-spec 8: REMARKS too long for the sheet continue on an overflow page,
// never truncated. jsPDF does not paginate one text call: about 58 lines fit.

const a3 = () => new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' })
const lineMm = REMARKS_PAGE.fontPt * 1.15 * 25.4 / 72

describe('REMARKS pages after the sheet', () => {
  it('a short text: one page, every line on it', () => {
    const pdf = a3()
    expect(writeRemarksPages(pdf, 'Game 1', 'Line one\nLine two')).toBe(1)
    expect(pdf.getNumberOfPages()).toBe(2)
  })

  it('200 lines: as many pages as needed, every line once, none below the bottom margin', () => {
    const pdf = a3()
    const lines = Array.from({ length: 200 }, (_, i) => `Remark ${i + 1}`)
    const printed: Array<{ text: string | string[]; y: number; page: number }> = []
    const text = pdf.text.bind(pdf)
    ;(pdf as any).text = (t: string | string[], x: number, y: number, ...rest: any[]) => {
      printed.push({ text: t, y, page: pdf.getCurrentPageInfo().pageNumber })
      return text(t, x, y, ...rest)
    }
    const pages = writeRemarksPages(pdf, 'Game 1', lines.join('\n'))
    expect(pages).toBeGreaterThan(2)
    expect(pdf.getNumberOfPages()).toBe(1 + pages)
    const bodies = printed.filter(p => Array.isArray(p.text)) as Array<{ text: string[]; y: number; page: number }>
    expect(bodies.flatMap(b => b.text)).toEqual(lines)
    for (const b of bodies) {
      const lastBaseline = b.y + (b.text.length - 1) * lineMm
      expect(lastBaseline).toBeLessThanOrEqual(A3_LANDSCAPE_MM.height - REMARKS_PAGE.margin + 0.01)
    }
    // one body per page, the pages after the first say they continue
    expect(new Set(bodies.map(b => b.page)).size).toBe(pages)
    expect(printed.filter(p => typeof p.text === 'string' && /REMARKS \(continued, page \d+ of \d+\)/.test(p.text))).toHaveLength(pages - 1)
  })

  it('splits by the line height: the first page holds fewer lines (heading and title above)', () => {
    const pages = remarksPageLines(Array.from({ length: 130 }, (_, i) => `${i}`), lineMm)
    expect(pages[0].length).toBeLessThan(pages[1].length)
    expect(pages.flat()).toHaveLength(130)
    // an empty text still gets its page (the caller only adds it when REMARKS overflowed)
    expect(remarksPageLines([], lineMm)).toEqual([[]])
  })
})
