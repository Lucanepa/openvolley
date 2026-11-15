/**
 * Dates of birth on 1 January (01.01.yyyy): often a placeholder (01.01.1900
 * where the real date is not known) or a bad import. The roster editor of
 * Match setup lists them as a note, where the dates are edited; the coin toss
 * neither shows nor checks them (owner 2026-11-15: "in the roster only, not
 * at coin toss"). Pure, no React.
 */

const DAY_FIRST = /^0?1[./-]0?1[./-]\d{4}$/
const ISO = /^\d{4}-01-01$/

/** The date ('DD.MM.YYYY', 'DD/MM/YYYY' or 'YYYY-MM-DD') is 1 January of some year. */
export function isJanuaryFirstDob(dob) {
  if (dob == null) return false
  const s = String(dob).trim()
  return DAY_FIRST.test(s) || ISO.test(s)
}

const nameOf = (x) => [x?.lastName, x?.firstName].map(v => String(v || '').trim()).filter(Boolean).join(' ')

/**
 * The players and bench officials of one team with a date of birth on
 * 1 January, in roster order: [{ name, dob }].
 * @param {object[]} [roster]
 * @param {object[]} [bench]
 */
export function januaryFirstDobs(roster = [], bench = []) {
  return [...(roster || []), ...(bench || [])]
    .filter(x => isJanuaryFirstDob(x?.dob))
    .map(x => ({
      name: nameOf(x) || (x.number != null && x.number !== '' ? `#${x.number}` : (x.role || '?')),
      dob: String(x.dob).trim()
    }))
}
