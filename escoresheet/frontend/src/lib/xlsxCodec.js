/**
 * xlsxCodec — reads and writes the small XLSX workbooks of OpenBeach's
 * tournament import (manager-beach, plan 3.4, phase T2): the cell values of
 * every sheet, and a template with a bold header row. An XLSX file is a zip
 * of XML parts; fflate (MIT, already shipped with jspdf) does the zip, the
 * browser's DOMParser the XML. No formulas, styles or dates are interpreted
 * here: a date is the number Excel stores (domain/beachImport.js converts
 * it by its column).
 *
 * Web only: the Android build (CAPACITOR=true) resolves this module to
 * xlsxCodec.stub.js (vite.config.js), and the import dialog loads it with a
 * dynamic import, so neither this code nor its zip reader ships in the APK.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/** False in the Android build's stub (xlsxCodec.stub.js). */
export const XLSX_AVAILABLE = true

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
// a workbook bigger than this when unpacked is not a tournament list (zip bombs)
const MAX_UNPACKED = 40 * 1024 * 1024
const MAX_ROWS = 5000
const MAX_COLS = 200

const parseXml = (text) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('xlsx: broken XML')
  return doc
}
const els = (node, name) => Array.from(node.getElementsByTagNameNS('*', name))
const attr = (el, name) => {
  if (el.hasAttribute(name)) return el.getAttribute(name)
  for (const a of Array.from(el.attributes)) if (a.localName === name.split(':').pop()) return a.value
  return null
}

/** 'A' -> 0, 'AB' -> 27 */
function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref || '')?.[1]
  if (!letters) return null
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}
/** 0 -> 'A', 27 -> 'AB' */
export function columnName(i) {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** The text of a shared string or inline string: its runs, without phonetic hints. */
function richText(si) {
  return els(si, 't').filter((t) => t.parentNode?.localName !== 'rPh').map((t) => t.textContent).join('')
}

/**
 * The sheets of an XLSX file, in workbook order.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{ sheets: Array<{ name: string, rows: Array<Array<string|number|boolean|null>> }>, date1904: boolean }}
 * @throws {Error} when it is not a readable XLSX workbook
 */
export function readWorkbook(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  let unpacked = 0
  let files
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        const wanted = f.name === 'xl/workbook.xml' || f.name === 'xl/_rels/workbook.xml.rels' || f.name === 'xl/sharedStrings.xml' ||
          /^xl\/worksheets\/[^/]+\.xml$/.test(f.name)
        if (!wanted) return false
        unpacked += f.originalSize
        if (unpacked > MAX_UNPACKED) throw new Error('xlsx: too big')
        return true
      }
    })
  } catch (err) {
    throw new Error(`xlsx: not a workbook (${err?.message || err})`)
  }
  if (!files['xl/workbook.xml']) throw new Error('xlsx: not a workbook')
  const workbook = parseXml(strFromU8(files['xl/workbook.xml']))
  const date1904 = els(workbook, 'workbookPr').some((p) => ['1', 'true'].includes(attr(p, 'date1904')))
  const targets = new Map()
  if (files['xl/_rels/workbook.xml.rels']) {
    for (const r of els(parseXml(strFromU8(files['xl/_rels/workbook.xml.rels'])), 'Relationship')) {
      const target = attr(r, 'Target') || ''
      targets.set(attr(r, 'Id'), target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
    }
  }
  const shared = files['xl/sharedStrings.xml'] ? els(parseXml(strFromU8(files['xl/sharedStrings.xml'])), 'si').map(richText) : []

  const sheets = []
  els(workbook, 'sheet').forEach((s, i) => {
    const rid = s.getAttributeNS(REL_NS, 'id') || attr(s, 'r:id')
    const path = targets.get(rid) || `xl/worksheets/sheet${i + 1}.xml`
    const xml = files[path]
    if (!xml) return
    sheets.push({ name: attr(s, 'name') || `Sheet${i + 1}`, rows: sheetRows(parseXml(strFromU8(xml)), shared) })
  })
  return { sheets, date1904 }
}

function sheetRows(doc, shared) {
  const rows = []
  let next = 0
  for (const row of els(doc, 'row')) {
    const r = Number(attr(row, 'r'))
    const index = Number.isInteger(r) && r >= 1 ? r - 1 : next
    next = index + 1
    if (index >= MAX_ROWS) break
    const cells = []
    let col = 0
    for (const c of Array.from(row.children).filter((x) => x.localName === 'c')) {
      const ci = columnIndex(attr(c, 'r'))
      col = ci ?? col
      if (col < MAX_COLS) cells[col] = cellValue(c, shared)
      col++
    }
    rows[index] = Array.from(cells, (v) => (v === undefined ? null : v))
  }
  return Array.from(rows, (r) => r || [])
}

function cellValue(c, shared) {
  const type = attr(c, 't') || 'n'
  const v = Array.from(c.children).find((x) => x.localName === 'v')?.textContent ?? null
  switch (type) {
    case 's': return v == null ? null : shared[Number(v)] ?? null
    case 'inlineStr': {
      const is = Array.from(c.children).find((x) => x.localName === 'is')
      return is ? richText(is) : null
    }
    case 'str':
    case 'd': return v
    case 'b': return v == null ? null : v === '1'
    case 'e': return null
    default: {
      if (v == null || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) ? n : v
    }
  }
}

// ------------------------------------------------------------------ writing
const esc = (s) => String(s)
  // characters XML 1.0 does not allow
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const sheetName = (s, i) => (String(s || '').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`)
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/**
 * An XLSX workbook. Every sheet's first row is bold and frozen; its columns
 * are formatted as text, so a licence like 00123 or a date typed as
 * 11.07.2026 stays as written.
 * @param {Array<{ name: string, rows: Array<Array<string|number|null>>, widths?: number[] }>} sheets
 * @returns {Uint8Array}
 */
export function writeWorkbook(sheets) {
  const names = sheets.map((s, i) => sheetName(s.name, i))
  const files = {
    '[Content_Types].xml': XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '</Types>',
    '_rels/.rels': XML_HEAD +
      `<Relationships xmlns="${PKG_REL_NS}">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml': XML_HEAD +
      `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>` +
      names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels': XML_HEAD +
      `<Relationships xmlns="${PKG_REL_NS}">` +
      names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
    // 0 normal, 1 bold text (the header), 2 text format '@' (the columns)
    'xl/styles.xml': XML_HEAD +
      `<styleSheet xmlns="${MAIN_NS}">` +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>' +
      '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
  }
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s) })
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level: 6 })
}

function sheetXml({ rows, widths = [] }) {
  const ncols = Math.max(1, ...rows.map((r) => r.length), widths.length)
  const cols = Array.from({ length: ncols }, (_, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${Math.max(8, Math.min(60, widths[i] || 14))}" style="2" customWidth="1"/>`).join('')
  const data = rows.map((row, r) => {
    const cells = row.map((v, c) => {
      if (v == null || v === '') return ''
      const ref = `${columnName(c)}${r + 1}`
      const style = r === 0 ? 1 : 2
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${style}"><v>${v}</v></c>`
      const text = String(v)
      const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t${space}>${esc(text)}</t></is></c>`
    }).join('')
    return `<row r="${r + 1}">${cells}</row>`
  }).join('')
  return XML_HEAD +
    `<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${data}</sheetData>` +
    '</worksheet>'
}
