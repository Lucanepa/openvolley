/**
 * What the scoresheet carries next to a person's name. Swiss sheets print the
 * date of birth; another country may print a licence / ID number, or any text
 * (a class, a school, a club), or nothing. A Global match chooses in Match
 * Setup (match.idMode); the value is stored in the same `dob` field of the
 * person, so a sheet, a backup and an import need no second column.
 *   'dob'     date of birth (the default, as in every Swiss match)
 *   'number'  a number (ID, licence)
 *   'text'    free text
 */
export const ID_MODES = ['dob', 'number', 'text']
export const DEFAULT_ID_MODE = 'dob'

export function idModeOf(match) {
  return ID_MODES.includes(match?.idMode) ? match.idMode : DEFAULT_ID_MODE
}

/** Fallback English column label per mode (the app translates `idMode.label.<mode>`). */
export const ID_LABEL_FALLBACK = { dob: 'Date of birth', number: 'ID number', text: 'Info' }
/** The short heading printed on the PDF's roster tables. */
export const ID_SHEET_HEADING = { dob: 'DoB', number: 'ID', text: 'Info' }

/** A typed value kept as the mode allows: digits only for 'number', trimmed length for 'text'. */
export function cleanIdValue(mode, raw) {
  const s = String(raw ?? '')
  if (mode === 'number') return s.replace(/[^0-9A-Za-z./-]/g, '').slice(0, 20)
  return s.slice(0, 40)
}
