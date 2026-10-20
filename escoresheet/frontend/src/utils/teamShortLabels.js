// The two short team labels the scoring screens show next to "A" / "B"
// (phone score cards, tablet team headers, line-up buttons).
//
// A configured short name wins: the match's (homeShortName / awayShortName,
// set in match setup or by the server) and else the team's own (teams.shortName).
// Without one, a label is derived from the name, without the club-type words
// most Swiss names start with: "VBC Einsiedeln D2" -> "Einsiedeln D2". The
// old fallback (the first 3 letters) gave "VBC" to both teams of
// "VBC Einsiedeln D2 - VBC Rämi D1" (2026-10-21).
//
// The two labels never read the same: equal configured names fall back to
// the derived ones, then to the full names, and two teams of the same name
// get "1" and "2".

// Club-type words: dropped from a derived label (any case, with or without dots)
const CLUB_WORDS = new Set([
  'VBC', 'VC', 'VB', 'VBG', 'VG', 'BC', 'TV', 'STV', 'DTV', 'KTV', 'TSV', 'SC', 'KSC', 'SV', 'SG', 'FC', 'USC',
  'VOLLEY', 'VOLLEYBALL', 'VOLLEYBALLCLUB', 'VOLLEYCLUB', 'CLUB', 'TEAM'
])

const blank = (v) => v == null || String(v).trim() === ''
const same = (a, b) => String(a).trim().toLocaleLowerCase() === String(b).trim().toLocaleLowerCase()

/** "VBC Einsiedeln D2" -> "Einsiedeln D2"; a name of club words only stays whole */
export function deriveTeamShortLabel(name) {
  if (blank(name)) return ''
  const words = String(name).trim().split(/\s+/)
  const kept = words.filter(w => !CLUB_WORDS.has(w.replace(/\./g, '').toLocaleUpperCase()))
  return (kept.length ? kept : words).join(' ')
}

/**
 * @param {{ shortName?: string, teamShortName?: string, name?: string }} a
 *   shortName: the match's short name; teamShortName: the team row's
 * @param {{ shortName?: string, teamShortName?: string, name?: string }} b
 * @returns {[string, string]} the labels of a and b ('' when a team has no name)
 */
export function teamShortLabels(a = {}, b = {}) {
  const configured = (t) => [t?.shortName, t?.teamShortName].find(v => !blank(v))
  const tries = [
    (t) => configured(t) ?? deriveTeamShortLabel(t?.name),
    (t) => deriveTeamShortLabel(t?.name),
    (t) => (blank(t?.name) ? '' : String(t.name).trim())
  ]
  for (const label of tries) {
    const pair = [String(label(a) ?? '').trim(), String(label(b) ?? '').trim()]
    if (!pair[0] || !pair[1] || !same(pair[0], pair[1])) return pair
  }
  return [`${deriveTeamShortLabel(a.name)} 1`, `${deriveTeamShortLabel(b.name)} 2`]
}
