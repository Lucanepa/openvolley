// The XLSX reader and writer of the tournament import (lib/xlsxCodec.js,
// plan 3.4, phase T2), and that the Android build gets the stub instead.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { strToU8, unzipSync, strFromU8, zipSync } from 'fflate'
import { columnName, readWorkbook, writeWorkbook, XLSX_AVAILABLE } from '../xlsxCodec'
import * as stub from '../xlsxCodec.stub'

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** A workbook as Excel writes it: shared strings, rich text, typed cells, a 1904 date system. */
function excelLike() {
  const files = {
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr date1904="1"/><sheets>` +
      `<sheet name="Spiele" sheetId="7" r:id="rId3"/><sheet name="Anmeldungen" sheetId="2" r:id="rId9"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId3" Type="x" Target="worksheets/sheet2.xml"/><Relationship Id="rId9" Type="x" Target="/xl/worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst xmlns="${MAIN}"><si><t>Draw</t></si><si><r><t>Mül</t></r><r><t xml:space="preserve">ler </t></r>` +
      '<rPh><t>ミュラー</t></rPh></si><si><t>Game #</t></si></sst>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="${MAIN}"><sheetData>` +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Wildcard</t></is></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>12345</v></c><c r="C3" t="b"><v>1</v></c><c r="D3" t="e"><v>#N/A</v></c><c r="E3" t="str"><v>formula</v></c></row>' +
      '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet xmlns="${MAIN}"><sheetData>` +
      '<row><c t="s"><v>2</v></c><c><v>1.5</v></c></row><row><c><v>3</v></c></row></sheetData></worksheet>',
    'xl/media/image1.png': 'not read'
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
}

describe('xlsxCodec', () => {
  it('reads what Excel writes: sheet order, shared and rich strings, types, gaps, 1904 dates', () => {
    const book = readWorkbook(excelLike())
    expect(book.date1904).toBe(true)
    expect(book.sheets.map((s) => s.name)).toEqual(['Spiele', 'Anmeldungen'])
    expect(book.sheets[0].rows).toEqual([['Game #', 1.5], [3]])
    expect(book.sheets[1].rows).toEqual([['Draw', null, 'Wildcard'], [], ['Müller ', 12345, true, null, 'formula']])
  })

  it('writes a workbook that reads back the same, with a bold frozen header and text columns', () => {
    const rows = [['Name', 'Seed'], ['Müller & <Söhne> "x"', 3], ['  spaced  ', null], ['ctrl\u0001char', '']]
    const bytes = writeWorkbook([{ name: 'Entries', rows, widths: [20] }, { name: 'a/b:c?*[d]'.repeat(5), rows: [['x']] }])
    const book = readWorkbook(bytes)
    expect(book.sheets[0].rows).toEqual([['Name', 'Seed'], ['Müller & <Söhne> "x"', 3], ['  spaced  '], ['ctrlchar']])
    expect(book.sheets[1].name.length).toBeLessThanOrEqual(31)
    expect(book.sheets[1].name).not.toMatch(/[[\]:*?/\\]/)
    const parts = unzipSync(bytes)
    const sheet = strFromU8(parts['xl/worksheets/sheet1.xml'])
    expect(sheet).toContain('state="frozen"')
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">')
    expect(sheet).toContain('style="2"')
    expect(strFromU8(parts['xl/styles.xml'])).toContain('<b/>')
    expect(strFromU8(parts['[Content_Types].xml'])).toContain('/xl/worksheets/sheet2.xml')
  })

  it('refuses what is not a workbook', () => {
    expect(() => readWorkbook(strToU8('Draw;Gender\nA1;W'))).toThrow(/not a workbook/)
    expect(() => readWorkbook(zipSync({ 'a.txt': strToU8('x') }))).toThrow(/not a workbook/)
  })

  it('names columns like Excel', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  })
})

describe('the Android build', () => {
  it('resolves the codec to a stub that reads and writes nothing', () => {
    expect(XLSX_AVAILABLE).toBe(true)
    expect(stub.XLSX_AVAILABLE).toBe(false)
    expect(() => stub.readWorkbook()).toThrow()
    expect(() => stub.writeWorkbook()).toThrow()
    expect(stub.columnName(27)).toBe('AB')
    // vite.config.js: under CAPACITOR=true the dialog's import of lib/xlsxCodec is the stub
    const config = readFileSync(resolve(__dirname, '../../../vite.config.js'), 'utf8')
    const line = config.split('\n').find((l) => l.includes('xlsxCodec.stub.js'))
    expect(line).toBeTruthy()
    const re = new RegExp(/find: \/(.+)\/, replacement/.exec(line)[1])
    const dialog = readFileSync(resolve(__dirname, '../../components/manage/tournaments/ImportModal.jsx'), 'utf8')
    const specifier = /import\('([^']*xlsxCodec)'\)/.exec(dialog)[1]
    expect(re.test(specifier)).toBe(true)
    expect(dialog).not.toMatch(/from '[^']*xlsxCodec'/)
  })
})
