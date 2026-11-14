// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { jsPDF } from 'jspdf'
import { needsUnicodeFont, applyTextFont, UNICODE_FONT } from '../pdfFont'

const require = createRequire(import.meta.url)
const fontPath = require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')
const loadFont = async () => readFileSync(fontPath).toString('base64')

// The text a PDF reader gets back from the file (pdf.js, as a viewer does)
async function textOf(pdf: jsPDF): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf.output('arraybuffer')), useSystemFonts: false, disableFontFace: true }).promise
  const page = await doc.getPage(1)
  const content = await page.getTextContent()
  return content.items.map((it: any) => it.str).join('')
}

const REMARK = 'Protest: Kovačević, Đorđe and Łukasz Ğül – the coach’s request at 14:12 (Müller)'

describe('pdfFont', () => {
  it('needs the embedded font only for characters outside Latin-1', () => {
    expect(needsUnicodeFont('Müller, Zoé – 25:23')).toBe(true)
    expect(needsUnicodeFont('Müller, Zoé - 25:23')).toBe(false)
    expect(needsUnicodeFont('Kovačević')).toBe(true)
  })

  it('a remark with non-Latin-1 letters and smart punctuation reads back unchanged', async () => {
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' })
    expect(await applyTextFont(pdf, REMARK, loadFont)).toBe(true)
    expect(pdf.getFont().fontName).toBe(UNICODE_FONT)
    pdf.text(pdf.splitTextToSize(REMARK, 390), 15, 38)
    expect((await textOf(pdf)).replace(/\s+/g, ' ')).toContain(REMARK)
  })

  it('Latin-1 text keeps Helvetica and loads no font', async () => {
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' })
    const load = vi.fn(loadFont)
    expect(await applyTextFont(pdf, 'Müller - 25:23', load)).toBe(false)
    expect(load).not.toHaveBeenCalled()
    expect(pdf.getFont().fontName).toBe('helvetica')
  })

  it('the font is embedded once per PDF, and a load failure falls back to Helvetica', async () => {
    const pdf = new jsPDF()
    const load = vi.fn(loadFont)
    await applyTextFont(pdf, REMARK, load)
    await applyTextFont(pdf, 'Đorđe', load)
    expect(load).toHaveBeenCalledTimes(1)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const other = new jsPDF()
    expect(await applyTextFont(other, REMARK, async () => { throw new Error('offline') })).toBe(false)
    expect(other.getFont().fontName).toBe('helvetica')
    warn.mockRestore()
  })
})
