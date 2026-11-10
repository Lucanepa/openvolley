/**
 * vmLicenceExport — reads a club administration export of VolleyManager
 * (XLSX: the club's players, scorers or coaches) in the browser, for the
 * club's licence lists (db/024, docs/club-licences-spec.md).
 *
 * Owner 2026-11-09: "just import dob, licence n, name, last name — that's all
 * we need", and the gender. The export carries much more (email, phone, home
 * address, nationality, categories, clubs, ...): none of it leaves this
 * module. readLicenceExport() answers the five fields per person and three
 * counts, nothing else; the rest of the file is never sent anywhere.
 *
 * The format (a real export, translated headers in German, French and
 * English): sheet "Sheet1", a title row, a blank row, the header row (row 3),
 * then one row per person. The columns are found by their header, in the
 * language whose headers match best (Italian "Nome" is the first name, French
 * "Nom" and German "Name" the last name). The licence column, when its header
 * is not one of these, is the column whose values are all 4 to 7 digit
 * numbers. A file without a licence, last name or first name column is
 * refused (LicenceExportError).
 *
 * An XLSX file is a zip of XML parts: jszip unpacks it, the browser's
 * DOMParser reads the XML. Dates: an Excel date cell (a serial number, 1900
 * system with its leap-year bug, or 1904), an ISO date (t="d" or text) or
 * DD.MM.YYYY text.
 */
import JSZip from 'jszip'

export const LICENCE_EXPORT_MAX_BYTES = 20 * 1024 * 1024
// an unpacked part bigger than this is not a club's list (zip bombs)
const MAX_PART_CHARS = 60 * 1024 * 1024
const MAX_ROWS = 20000
const HEADER_SCAN_ROWS = 30
const NAME_MAX = 100
const SV_RE = /^[0-9]{4,7}$/

const W = (...a) => a
/** Header names per language (normalized: see normalizeHeader) and the gender values. */
export const EXPORT_LANGUAGES = Object.freeze({
  it: {
    sv_number: W('n sv'),
    last_name: W('cognome'),
    first_name: W('nome'),
    dob: W('data di nascita'),
    gender: W('sesso'),
    genders: { d: 'f', u: 'm' }
  },
  de: {
    sv_number: W('sv-nr', 'sv nr', 'sv-nummer'),
    last_name: W('name', 'nachname'),
    first_name: W('vorname'),
    dob: W('geburtsdatum'),
    gender: W('geschlecht'),
    genders: { w: 'f', f: 'f', m: 'm' }
  },
  fr: {
    sv_number: W('n° sv', 'no sv', 'n sv'),
    last_name: W('nom'),
    first_name: W('prénom'),
    dob: W('date de naissance'),
    gender: W('sexe'),
    genders: { f: 'f', h: 'm', m: 'm' }
  },
  en: {
    sv_number: W('sv no', 'sv number'),
    last_name: W('last name', 'surname'),
    first_name: W('first name'),
    dob: W('date of birth'),
    gender: W('gender', 'sex'),
    genders: { f: 'f', w: 'f', m: 'm' }
  }
})
// A gender cell in any of the languages, whichever the headers are in: a
// letter (D/U, W/M, F/H, F/M) or a word ("Donna", "weiblich", "Homme", "male")
const GENDER_WORDS = Object.freeze({
  f: ['f', 'w', 'd', 'female', 'woman', 'women', 'weiblich', 'frau', 'damen', 'femme', 'féminin', 'feminin', 'dames', 'femmina', 'femminile', 'donna', 'donne'],
  m: ['m', 'h', 'u', 'male', 'man', 'men', 'männlich', 'maennlich', 'mann', 'herren', 'homme', 'masculin', 'hommes', 'maschio', 'maschile', 'uomo', 'uomini']
})
const GENDER_OF = new Map(Object.entries(GENDER_WORDS).flatMap(([g, words]) => words.map((w) => [w, g])))
/** A gender cell -> 'f', 'm' or null: the header language's letters first, then any language's. */
export function genderOf(value, genders = {}) {
  const v = String(value ?? '').trim().toLowerCase().replace(/[.]/g, '')
  if (!v) return null
  return genders[v] || GENDER_OF.get(v) || null
}
const FIELDS = ['sv_number', 'last_name', 'first_name', 'dob', 'gender']
const REQUIRED = ['sv_number', 'last_name', 'first_name']

/** A file this module refuses: `code` names why, `missing` the columns not found. */
export class LicenceExportError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'LicenceExportError'
    this.code = code
    Object.assign(this, extra)
  }
}

/** Lowercase, trimmed, spaces collapsed, dots and colons dropped: "N. SV" -> "n sv". */
export function normalizeHeader(value) {
  return String(value ?? '').toLowerCase().replace(/[.:]/g, ' ').replace(/\s+/g, ' ').trim()
}

const pad = (n) => String(n).padStart(2, '0')
const validYmd = (y, m, d) => {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null
}

/**
 * An Excel date serial -> 'YYYY-MM-DD' (the time of day dropped), or null.
 * 1900 system: 1 = 1900-01-01; Excel counts a 29 February 1900 that never
 * was (serial 60, null here), so from 61 on a day comes off. 1904 system
 * (date1904): 0 = 1904-01-01.
 */
export function excelSerialToIso(serial, { date1904 = false } = {}) {
  const n = Math.floor(Number(serial))
  if (!Number.isFinite(n) || n < (date1904 ? 0 : 1) || n > 2958465) return null
  let ms
  if (date1904) ms = Date.UTC(1904, 0, 1) + n * 86400000
  else if (n === 60) return null
  else ms = Date.UTC(1899, 11, n < 60 ? 31 : 30) + n * 86400000
  const t = new Date(ms)
  return validYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/** A date of birth cell -> 'YYYY-MM-DD' or null: a serial, an ISO date (with or without a time), DD.MM.YYYY. */
export function cellToIsoDate(value, opts = {}) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return excelSerialToIso(value, opts)
  const s = String(value).trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s)
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s)
  if (m) return validYmd(Number(m[3]), Number(m[2]), Number(m[1]))
  // a serial stored as text
  if (/^\d{1,6}(\.\d+)?$/.test(s)) return excelSerialToIso(Number(s), opts)
  return null
}

/** A licence cell -> '123456' or null (4 to 7 digits; a number cell is an integer). */
function licenceOf(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? (SV_RE.test(String(value)) ? String(value) : null) : null
  const s = String(value ?? '').trim()
  return SV_RE.test(s) ? s : null
}
const nameOf = (value) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, NAME_MAX) : ''
}
const isEmpty = (v) => v == null || (typeof v === 'string' && v.trim() === '')

/** The best header row and language of `rows` (arrays of cell values): { index, language, columns } or null. */
function findHeader(rows) {
  let best = null
  for (let r = 0; r < Math.min(rows.length, HEADER_SCAN_ROWS); r++) {
    const cells = (rows[r] || []).map(normalizeHeader)
    if (!cells.some(Boolean)) continue
    for (const [language, spec] of Object.entries(EXPORT_LANGUAGES)) {
      const columns = {}
      for (const f of FIELDS) {
        const i = cells.findIndex((c, ci) => c && spec[f].includes(c) && !Object.values(columns).includes(ci))
        if (i !== -1) columns[f] = i
      }
      const score = Object.keys(columns).length
      // the first row and language with the most columns found; a tie keeps the earlier one
      if (score >= 2 && (!best || score > best.score)) best = { index: r, language, columns, score }
    }
  }
  return best
}

/**
 * The people of a sheet's rows (arrays of cell values, the first row first):
 * { people: [{ sv_number, last_name, first_name, dob, gender }], rows, skipped, language }.
 * `rows`: data rows with something in them; `skipped`: those without a
 * licence number of 4 to 7 digits or a last name. Throws LicenceExportError.
 */
export function licencePeopleFromRows(rows, { date1904 = false } = {}) {
  const header = findHeader(rows)
  if (!header) throw new LicenceExportError('OV_LICENCE_NO_HEADER', 'No header row with licence number, last name and first name', { missing: [...REQUIRED] })
  const { index, language } = header
  const columns = { ...header.columns }
  const data = rows.slice(index + 1).filter((row) => (row || []).some((v) => !isEmpty(v)))
  if (columns.sv_number === undefined) {
    // the column whose non-empty values are all licence numbers
    const width = Math.max(0, ...data.map((row) => row.length))
    const taken = new Set(Object.values(columns))
    for (let c = 0; c < width; c++) {
      if (taken.has(c)) continue
      const values = data.map((row) => row[c]).filter((v) => !isEmpty(v))
      if (values.length && values.every((v) => licenceOf(v) !== null)) {
        columns.sv_number = c
        break
      }
    }
  }
  const missing = REQUIRED.filter((f) => columns[f] === undefined)
  if (missing.length) throw new LicenceExportError('OV_LICENCE_NO_HEADER', `Columns not found: ${missing.join(', ')}`, { missing, language })
  const genders = EXPORT_LANGUAGES[language].genders
  const people = []
  const seen = new Map()
  let skipped = 0
  for (const row of data) {
    const sv = licenceOf(row[columns.sv_number])
    const last = nameOf(row[columns.last_name])
    if (!sv || !last) {
      skipped++
      continue
    }
    const first = nameOf(row[columns.first_name]) || null
    const dob = columns.dob === undefined ? null : cellToIsoDate(row[columns.dob], { date1904 })
    const gender = columns.gender === undefined ? null : genderOf(row[columns.gender], genders)
    // a licence number twice is one person (the server merges the same way)
    const prev = seen.get(sv)
    if (prev) {
      prev.first_name ??= first
      prev.dob ??= dob
      prev.gender ??= gender
      continue
    }
    const person = { sv_number: sv, last_name: last, first_name: first, dob, gender }
    seen.set(sv, person)
    people.push(person)
  }
  return { people, rows: data.length, skipped, language }
}

// ---------------------------------------------------------------- the XLSX file
const parseXml = (text) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new LicenceExportError('OV_LICENCE_NOT_XLSX', 'Broken XML in the file')
  return doc
}
const els = (node, name) => Array.from(node.getElementsByTagNameNS('*', name))
const attr = (el, name) => {
  if (el.hasAttribute(name)) return el.getAttribute(name)
  for (const a of Array.from(el.attributes)) if (a.localName === name.split(':').pop()) return a.value
  return null
}
/** 'A' -> 0, 'AB' -> 27, null without letters */
function columnIndex(ref) {
  const letters = /^([A-Z]+)/i.exec(ref || '')?.[1]
  if (!letters) return null
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}
/** The text of a shared or inline string: its runs, without phonetic hints. */
const richText = (node) => els(node, 't').filter((t) => t.parentNode?.localName !== 'rPh').map((t) => t.textContent).join('')

async function readPart(zip, path) {
  const f = zip.file(path.replace(/^\//, ''))
  if (!f) return null
  const text = await f.async('string')
  if (text.length > MAX_PART_CHARS) throw new LicenceExportError('OV_LICENCE_TOO_BIG', 'The file is too big for a club list')
  return text
}
/** A relationship target -> a path in the zip, relative to the part's folder. */
function resolveTarget(base, target) {
  if (!target) return null
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}
const relsPathOf = (part) => {
  const i = part.lastIndexOf('/')
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`
}

/** The cell values of the workbook's first sheet: rows (arrays, row 1 first) and the date system. */
async function firstSheetRows(zip) {
  const rootRels = await readPart(zip, '_rels/.rels')
  let workbookPath = 'xl/workbook.xml'
  if (rootRels) {
    const rel = els(parseXml(rootRels), 'Relationship').find((r) => /\/officeDocument$/.test(attr(r, 'Type') || ''))
    if (rel) workbookPath = resolveTarget('', attr(rel, 'Target')) || workbookPath
  }
  const workbookXml = await readPart(zip, workbookPath)
  if (!workbookXml) throw new LicenceExportError('OV_LICENCE_NOT_XLSX', 'No workbook in the file')
  const workbook = parseXml(workbookXml)
  const date1904 = els(workbook, 'workbookPr').some((p) => ['1', 'true'].includes(String(attr(p, 'date1904') || '').toLowerCase()))
  const sheet = els(workbook, 'sheet')[0]
  if (!sheet) throw new LicenceExportError('OV_LICENCE_NO_SHEET', 'The workbook has no sheet')
  const relsXml = await readPart(zip, relsPathOf(workbookPath))
  const rels = relsXml ? els(parseXml(relsXml), 'Relationship') : []
  const rid = attr(sheet, 'r:id') || attr(sheet, 'id')
  const sheetRel = rels.find((r) => attr(r, 'Id') === rid)
  const sheetPath = sheetRel ? resolveTarget(workbookPath, attr(sheetRel, 'Target')) : 'xl/worksheets/sheet1.xml'
  const sharedRel = rels.find((r) => /\/sharedStrings$/.test(attr(r, 'Type') || ''))
  const sharedXml = await readPart(zip, sharedRel ? resolveTarget(workbookPath, attr(sharedRel, 'Target')) : 'xl/sharedStrings.xml')
  const shared = sharedXml ? els(parseXml(sharedXml), 'si').map(richText) : []
  const sheetXml = await readPart(zip, sheetPath)
  if (!sheetXml) throw new LicenceExportError('OV_LICENCE_NO_SHEET', 'The first sheet is missing')
  const rows = []
  let rowSeq = 0
  for (const row of els(parseXml(sheetXml), 'row')) {
    const r = Number(attr(row, 'r')) || rowSeq + 1
    rowSeq = r
    if (r > MAX_ROWS) throw new LicenceExportError('OV_LICENCE_TOO_BIG', 'The sheet has too many rows for a club list')
    const values = []
    let colSeq = -1
    for (const c of els(row, 'c')) {
      const col = columnIndex(attr(c, 'r')) ?? colSeq + 1
      colSeq = col
      if (col > 500) continue
      const type = attr(c, 't') || 'n'
      const v = els(c, 'v')[0]?.textContent ?? null
      let value = null
      if (type === 's') value = v == null ? null : (shared[Number(v)] ?? null)
      else if (type === 'inlineStr') value = els(c, 'is').map(richText).join('')
      else if (type === 'str' || type === 'd') value = v
      else if (type === 'b') value = v === '1'
      else if (type === 'e') value = null
      else value = v == null || v === '' ? null : Number(v)
      values[col] = value
    }
    rows[r - 1] = values
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = []
  return { rows, date1904 }
}

/**
 * Read a club administration export: a File, Blob, ArrayBuffer or
 * Uint8Array of an .xlsx file. -> { people: [{ sv_number, last_name,
 * first_name, dob, gender }], rows, skipped, language }. Nothing else of the
 * file leaves this function. Throws LicenceExportError (code
 * OV_LICENCE_NOT_XLSX, OV_LICENCE_TOO_BIG, OV_LICENCE_NO_SHEET or
 * OV_LICENCE_NO_HEADER with `missing`).
 */
export async function readLicenceExport(input) {
  let data = input
  if (data && typeof data.arrayBuffer === 'function') data = await data.arrayBuffer()
  const size = data?.byteLength ?? 0
  if (!size) throw new LicenceExportError('OV_LICENCE_NOT_XLSX', 'The file is empty')
  if (size > LICENCE_EXPORT_MAX_BYTES) throw new LicenceExportError('OV_LICENCE_TOO_BIG', 'The file is too big for a club list')
  let zip
  try {
    zip = await JSZip.loadAsync(data)
  } catch {
    throw new LicenceExportError('OV_LICENCE_NOT_XLSX', 'Not an .xlsx file')
  }
  const { rows, date1904 } = await firstSheetRows(zip)
  return licencePeopleFromRows(rows, { date1904 })
}
