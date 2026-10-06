/**
 * The volleyball season of a kick-off, on the Europe/Zurich clock. A season
 * starts on 1 July: 2026-07-01 00:00 Zurich is season 2026 ('2026/27'), one
 * minute earlier is 2025. Identical to the backend's lib/officialGame.js
 * seasonOf and to the SQL in db/007 (official-game key, spec section 2).
 */

const ZURICH_YEAR_MONTH = new Intl.DateTimeFormat('en-CH', {
  timeZone: 'Europe/Zurich',
  year: 'numeric',
  month: 'numeric'
})

/**
 * @param {Date|string|number|null|undefined} dateLike
 * @returns {number|null} the season's first year, or null for a missing or invalid date
 */
export function seasonOf(dateLike) {
  if (dateLike === null || dateLike === undefined || dateLike === '') return null
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike)
  if (Number.isNaN(d.getTime())) return null
  let year = null
  let month = null
  for (const p of ZURICH_YEAR_MONTH.formatToParts(d)) {
    if (p.type === 'year') year = Number(p.value)
    else if (p.type === 'month') month = Number(p.value)
  }
  if (!year || !month) return null
  return month < 7 ? year - 1 : year
}

/** seasonLabel(2026) → '2026/27', the format of competitions.season. */
export function seasonLabel(season) {
  const y = Number(season)
  if (!Number.isInteger(y)) return ''
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`
}

/** '2026/27' → 2026, or null. */
export function parseSeasonLabel(label) {
  const m = /^(\d{4})\/(\d{2})$/.exec(String(label || ''))
  return m ? Number(m[1]) : null
}

/** The season of now, and its neighbours (for season pickers). */
export function seasonOptions(around = new Date(), span = 1) {
  const s = seasonOf(around) ?? new Date().getFullYear()
  const out = []
  for (let y = s - span; y <= s + span; y++) out.push(seasonLabel(y))
  return out
}
