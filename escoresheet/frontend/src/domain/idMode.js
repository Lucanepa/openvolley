/**
 * What the scoresheet carries next to a person's name. The value is stored in
 * the person's `dob` field whatever it holds, so a sheet, a backup and an
 * import need no second column.
 *
 * A Swiss match (every match that is not Global) carries the licence number,
 * or a date of birth when the scorer types one (owner 2026-11-19: "either a
 * birthday (recognized as such with the '.') OR licence number. the latter is
 * default"): mode 'licence'. A Global match chooses in Match Setup
 * (match.idMode):
 *   'dob'     date of birth (the Global default)
 *   'number'  a number (ID, licence)
 *   'text'    free text
 *
 * The value rule of 'licence' (the server's migration uses the same one to
 * tell the dates it removes from the licences it keeps):
 *   - a DATE matches DAY_FIRST_DATE (1-2 digit day and month, '.', '/' or
 *     '-', 2-4 digit year) or starts like an ISO date; it is written
 *     dd.mm.yyyy;
 *   - anything else is a licence: its digits only, at most LICENCE_MAX;
 *   - the 01.01.1900 placeholder of older matches is empty.
 */
export const ID_MODES = ['dob', 'number', 'text']
export const DEFAULT_ID_MODE = 'dob'
// Every match that is not Global
export const SWISS_ID_MODE = 'licence'
export const LICENCE_MAX = 10

export function idModeOf(match) {
  if (match?.global !== true) return SWISS_ID_MODE
  return ID_MODES.includes(match?.idMode) ? match.idMode : DEFAULT_ID_MODE
}

/** Fallback English column label per mode (the app translates `idMode.label.<mode>`). */
export const ID_LABEL_FALLBACK = { dob: 'Date of birth', number: 'ID number', text: 'Info', licence: 'Licence' }
/** The short heading printed on the PDF's roster and APPROVAL tables (scoresheet_pdf sheetFormat idHeadingOf). */
export const ID_SHEET_HEADING = { dob: 'DoB', number: 'ID', text: 'Info', licence: 'Licence' }

export const DAY_FIRST_DATE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/
export const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/
const PLACEHOLDER = /^0?1[./-]0?1[./-]1900$|^1900-01-01/

/** The 01.01.1900 "not known" placeholder of older matches (any of its spellings). */
export function isPlaceholderValue(v) {
  return PLACEHOLDER.test(String(v ?? '').trim())
}

/** The value is a date (the separator tells it: '.', '/' or '-', or ISO), not a licence. */
export function isDateValue(v) {
  if (v === null || v === undefined) return false
  const s = String(v).trim()
  return DAY_FIRST_DATE.test(s) || ISO_DATE.test(s)
}

// A two-digit year: this century up to this year, else the last one
function fullYear(y, now = new Date()) {
  if (y.length !== 2) return y
  const n = Number(y)
  return String(n <= now.getFullYear() % 100 ? 2000 + n : 1900 + n)
}

/** A date value written dd.mm.yyyy (null when it is no date). */
export function dateValueText(v) {
  if (!isDateValue(v)) return null
  const s = String(v).trim()
  const iso = ISO_DATE.exec(s)
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`
  const [, d, m, y] = DAY_FIRST_DATE.exec(s)
  return `${d.padStart(2, '0')}.${m.padStart(2, '0')}.${fullYear(y)}`
}

/** The licence number a value holds: its digits when it is no date and has nothing else (spaces aside), else null. */
export function licenceOf(v) {
  if (v === null || v === undefined || isDateValue(v)) return null
  const s = String(v).replace(/\s+/g, '')
  return /^\d+$/.test(s) ? s.slice(0, LICENCE_MAX) : null
}

/**
 * A value kept as the mode allows: 'number' digits, letters and date
 * separators; 'text' trimmed length; 'licence' the value rule above (a date
 * dd.mm.yyyy, else the digits, the placeholder empty). Use it on what is
 * stored; typedIdValue while the person types.
 */
export function cleanIdValue(mode, raw) {
  const s = String(raw ?? '')
  if (mode === 'number') return s.replace(/[^0-9A-Za-z./-]/g, '').slice(0, 20)
  if (mode === 'licence') {
    if (!s.trim() || isPlaceholderValue(s)) return ''
    return dateValueText(s) ?? s.replace(/\D/g, '').slice(0, LICENCE_MAX)
  }
  return s.slice(0, 40)
}

/**
 * What a field keeps while the person types: in 'licence' digits and the
 * date separators (a date is still being typed: 14.03.20…), at most
 * dd.mm.yyyy long; cleanIdValue when the field is left.
 */
export function typedIdValue(mode, raw) {
  if (mode === 'licence') return String(raw ?? '').replace(/[^0-9./-]/g, '').slice(0, LICENCE_MAX)
  return cleanIdValue(mode, raw)
}

/** A person's licence: their value when it is one, else an older match's own `licence` field (the scorer). */
export function personLicence(person) {
  return licenceOf(person?.dob) ?? licenceOf(person?.licence)
}

/**
 * What an Einsatzliste brings beside a name (owner 2026-11-19: "for
 * switzerland: import only the licence number from the einsatzliste"): the
 * person's licence (parseRosterPdf `licence`, the SV number), never the date
 * of birth the list prints (the parser reads that only to find the rows). A
 * Global match on birthdates gets nothing there.
 */
export function importedIdValue(person, mode) {
  return mode === 'dob' ? '' : (licenceOf(person?.licence) || '')
}

/**
 * The column label of a mode in the app: `dobLabel` (the screen's own,
 * long-translated date of birth label) for 'dob', else `idMode.label.<mode>`.
 * @param {(key: string, fallback?: string) => string} t
 */
export function idLabelOf(t, mode, dobLabel) {
  return mode === 'dob' ? dobLabel : t(`idMode.label.${mode}`, ID_LABEL_FALLBACK[mode] || ID_LABEL_FALLBACK.licence)
}
