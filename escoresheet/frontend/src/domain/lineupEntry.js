// Line-up entry (the scorer's line-up modal): which roster players can be
// picked, and what is wrong with each of the six positions.
//
// The errors are derived from the whole line-up every time (never stored per
// field), so fixing a duplicate in either box clears it in both.

/** Line-up array order used by the modal: front row IV III II, back row V VI I */
export const LINEUP_POSITIONS = ['IV', 'III', 'II', 'V', 'VI', 'I']

/** Error codes, in the order a box shows them (one message per box) */
export const LINEUP_ERRORS = {
  required: 'required',
  notOnRoster: 'notOnRoster',
  libero: 'libero',
  disqualified: 'disqualified',
  exceptionallySubstituted: 'exceptionallySubstituted',
  duplicate: 'duplicate'
}

const isBlank = (v) => v == null || String(v).trim() === ''
const sameNumber = (a, b) => a != null && b != null && String(a) === String(b)
const isLiberoPlayer = (p) => !!(p?.libero && p.libero !== '')

function isDisqualified(events, team, number) {
  return (events || []).some(e =>
    e.type === 'sanction' &&
    e.payload?.team === team &&
    sameNumber(e.payload?.playerNumber, number) &&
    e.payload?.type === 'disqualification'
  )
}

function wasExceptionallySubstituted(events, team, number) {
  return (events || []).some(e =>
    e.type === 'substitution' &&
    e.payload?.team === team &&
    sameNumber(e.payload?.playerOut, number) &&
    e.payload?.isExceptional === true
  )
}

/**
 * The error of every position, computed from the current values only.
 *
 * - required: an empty box, only once the scorer has tried to confirm
 *   (`requireAll`), so an incomplete line-up is not flagged while it is
 *   being filled
 * - notOnRoster / libero / disqualified / exceptionallySubstituted: per box
 * - duplicate: every box holding a number that appears more than once (it
 *   wins over the per-box checks, as the modal always did)
 *
 * @param {object} args
 * @param {string[]} args.lineup six values in LINEUP_POSITIONS order ('' = empty)
 * @param {object[]} [args.players] the team's roster ({ number, libero })
 * @param {object[]} [args.events] the match events (disqualifications, exceptional substitutions)
 * @param {'home'|'away'} [args.team]
 * @param {boolean} [args.requireAll] flag empty boxes as required
 * @returns {Record<number, string>} position index -> LINEUP_ERRORS code (valid boxes are absent)
 */
export function lineupEntryErrors({ lineup, players = [], events = [], team = null, requireAll = false }) {
  const values = (lineup || []).map(v => (isBlank(v) ? '' : String(Number(v))))
  const counts = values.reduce((acc, v) => {
    if (v) acc[v] = (acc[v] || 0) + 1
    return acc
  }, {})
  const errors = {}
  values.forEach((value, i) => {
    if (!value) {
      if (requireAll) errors[i] = LINEUP_ERRORS.required
      return
    }
    if (counts[value] > 1) {
      errors[i] = LINEUP_ERRORS.duplicate
      return
    }
    const player = (players || []).find(p => sameNumber(p.number, value))
    if (!player) errors[i] = LINEUP_ERRORS.notOnRoster
    else if (isLiberoPlayer(player)) errors[i] = LINEUP_ERRORS.libero
    else if (isDisqualified(events, team, value)) errors[i] = LINEUP_ERRORS.disqualified
    else if (wasExceptionallySubstituted(events, team, value)) errors[i] = LINEUP_ERRORS.exceptionallySubstituted
  })
  return errors
}

/**
 * Roster players the scorer can still pick: not a libero, not already in
 * the line-up, not out of the game (disqualified, or substituted
 * exceptionally or because of a disqualification) and not expelled in this
 * set. Sorted by shirt number.
 */
export function lineupCandidates({ players = [], lineup = [], events = [], team = null, setIndex = null }) {
  const taken = new Set((lineup || []).filter(v => !isBlank(v)).map(v => String(Number(v))))
  const evts = events || []
  const subbedOut = (number, flag, inSet = false) => evts.some(e =>
    e.type === 'substitution' &&
    e.payload?.team === team &&
    sameNumber(e.payload?.playerOut, number) &&
    e.payload?.[flag] === true &&
    (!inSet || e.setIndex === setIndex)
  )
  const sanctioned = (number, type, inSet = false) => evts.some(e =>
    e.type === 'sanction' &&
    e.payload?.team === team &&
    sameNumber(e.payload?.playerNumber, number) &&
    e.payload?.type === type &&
    (!inSet || e.setIndex === setIndex)
  )
  return (players || [])
    .filter(p => {
      if (isLiberoPlayer(p)) return false
      if (taken.has(String(Number(p.number)))) return false
      if (subbedOut(p.number, 'isDisqualified') || subbedOut(p.number, 'isExceptional')) return false
      if (setIndex && (subbedOut(p.number, 'isExpelled', true) || sanctioned(p.number, 'expulsion', true))) return false
      if (sanctioned(p.number, 'disqualification')) return false
      return true
    })
    .sort((a, b) => Number(a.number) - Number(b.number))
}
