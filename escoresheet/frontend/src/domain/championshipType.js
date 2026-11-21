/**
 * The championship type of a match (Match setup › Match type, Edit match info).
 *
 * Stored lowercase on the match as `championshipType` (on the server
 * match_info.championship_type), one of CHAMPIONSHIP_TYPES; 'other' has its
 * text in `championshipTypeOther` (match_info.championship_type_other).
 * The paper scoresheet (scoresheet_pdf Header.tsx) ticks a box only for the
 * exact lowercase value: "Regional" typed by hand left every box empty
 * (owner 2026-11-20, Edit match info had a free text field).
 */

export const CHAMPIONSHIP_TYPES = ['regional', 'national', 'international', 'other']

const text = (v) => (typeof v === 'string' ? v : '')

/**
 * The championship type as the select shows it: one of CHAMPIONSHIP_TYPES or
 * '' (none). A value typed by hand before the select ("Regional",
 * " national ") maps case-insensitively; any other text becomes "Other" with
 * that text as its own (unless the match has one already).
 * @param {Record<string, any>} [match]
 * @returns {{ championshipType: string, championshipTypeOther: string }}
 */
export function championshipTypeFields(match) {
  const raw = text(match?.championshipType || match?.championship_type).trim()
  const other = text(match?.championshipTypeOther)
  if (!raw) return { championshipType: '', championshipTypeOther: other }
  const known = CHAMPIONSHIP_TYPES.find(v => v === raw.toLowerCase())
  if (known) return { championshipType: known, championshipTypeOther: other }
  return { championshipType: 'other', championshipTypeOther: other.trim() ? other : raw }
}

/**
 * The two fields as they are saved: the type or null, and the "Other" text
 * only with 'other' (as Match setup saves them).
 * @param {Record<string, any>} [match]
 * @returns {{ championshipType: string|null, championshipTypeOther: string|null }}
 */
export function championshipTypeToSave(match) {
  const { championshipType, championshipTypeOther } = championshipTypeFields(match)
  return {
    championshipType: championshipType || null,
    championshipTypeOther: championshipType === 'other' ? (championshipTypeOther || null) : null
  }
}
