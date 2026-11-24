// The starting line-up of an earlier set, to fill the line-up being entered
// (owner 2026-11-22: "use last set lineup", and the starting line-up of the
// other sets too): the scorer's line-up dialog and the bench's line-up
// sheet. Only a pre-fill: the dialog checks the six as if typed (a player
// disqualified, expelled for the set, out of the match or a libero now is
// flagged) and nothing is saved before Confirm.
//
// The STARTING line-up of a set, as the scoresheet reads it (manualCorrections
// startingLineupEvent, scoresheetModel getStartingLineupEvent): the last
// line-up entered before the set's first point (a correction before the first
// serve counts), else the set's first line-up row; never the line-up at the
// end of the set (substitutions, rotations, libero replacements).

const POSITIONS = ['I', 'II', 'III', 'IV', 'V', 'VI']
const setOf = (e) => Number(e?.setIndex ?? 1)
const bySeq = (a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0)
// a bench request's line-up may hold { number } per position
const numberOf = (v) => (v && typeof v === 'object' && v.number !== undefined ? v.number : v)
const asNumber = (v) => {
  const n = numberOf(v)
  return n === undefined || n === null || String(n).trim() === '' ? '' : String(Number(n))
}
// a line-up the scorer entered (the starting one or a correction), not one
// the app wrote for a substitution, a rotation or a libero replacement
const isEnteredLineup = (e) => {
  const p = e?.payload || {}
  return e?.type === 'lineup' && typeof p.isInitial === 'boolean' && !p.fromSubstitution && !p.fromRotation &&
    (p.liberoSubstitution === undefined || p.liberoSubstitution === null)
}

/**
 * The starting line-up of `team` in set `setIndex`, by position
 * ({ I: '7', II: '12', ... }; '' for a position without a number), or null
 * when the team has no line-up in that set.
 */
export function startingLineupOf(events, setIndex, team) {
  const ofSet = (events || []).filter(e => e && setOf(e) === Number(setIndex)).sort(bySeq)
  const rows = ofSet.filter(e => e.type === 'lineup' && e.payload?.team === team && e.payload?.lineup)
  if (rows.length === 0) return null
  const firstPoint = ofSet.find(e => e.type === 'point')
  const entered = rows.filter(e => isEnteredLineup(e) && (!firstPoint || bySeq(e, firstPoint) < 0))
  const row = entered[entered.length - 1] || rows.find(e => e.payload?.isInitial === true) || rows[0]
  return Object.fromEntries(POSITIONS.map(pos => [pos, asNumber(row.payload.lineup[pos])]))
}

/**
 * The sets before `setIndex` with a starting line-up of `team`, the latest
 * first: [{ setIndex, lineup }]. A best-of-3 decider (index 5) comes after
 * sets 1 and 2 (utils/matchFormat displaySetNumber).
 */
export function earlierStartingLineups(events, team, setIndex) {
  const indexes = [...new Set((events || []).filter(e => e?.type === 'lineup' && e.payload?.team === team).map(setOf))]
    .filter(i => i < Number(setIndex))
    .sort((a, b) => b - a)
  const out = []
  for (const i of indexes) {
    const lineup = startingLineupOf(events, i, team)
    if (lineup && POSITIONS.some(pos => lineup[pos] !== '')) out.push({ setIndex: i, lineup })
  }
  return out
}
