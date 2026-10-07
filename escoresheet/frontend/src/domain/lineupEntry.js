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

// ---------------------------------------------------------------------------
// Optional game captain, chosen while the line-up is entered.
//
// FIVB 5.2: the team captain is the game captain while on court. When the
// team captain is not on court, the coach (or the team captain) names another
// player on court as game captain until the team captain comes back, and the
// scoresheet records it. The app keeps this in two match fields:
//   <team>CourtCaptain            the player acting as game captain now
//   <team>RememberedCourtCaptain  the player used again, without asking, the
//                                 next time the team captain leaves the court
// and logs a 'court_captain_designation' event when someone becomes game
// captain (the same path as the "Game captain" prompt on the scoreboard).
//
// Liberos: a libero cannot be in the six boxes at all (lineupEntryErrors flags
// it), so it is never offered here. The court can still show a libero as game
// captain after a libero replacement ('LC'); that is decided on court, not in
// the line-up.
// ---------------------------------------------------------------------------

const courtCaptainFields = (team) => (team === 'home'
  ? { court: 'homeCourtCaptain', remembered: 'homeRememberedCourtCaptain' }
  : { court: 'awayCourtCaptain', remembered: 'awayRememberedCourtCaptain' })

/** Shirt number of the team captain (C on the roster), as a string, or null */
export function teamCaptainNumber(players = []) {
  const captain = (players || []).find(p => p?.isCaptain || p?.captain)
  return captain && !isBlank(captain.number) ? String(Number(captain.number)) : null
}

/**
 * Where the team captain stands for the line-up being entered:
 * - 'noCaptain'   no team captain on the roster (nothing to choose)
 * - 'onCourt'     the team captain is one of the six
 * - 'offCourt'    the team captain is not one of the six
 */
export function lineupCaptainStatus({ lineup = [], players = [] }) {
  const captain = teamCaptainNumber(players)
  if (!captain) return 'noCaptain'
  const values = (lineup || []).filter(v => !isBlank(v)).map(v => String(Number(v)))
  return values.includes(captain) ? 'onCourt' : 'offCourt'
}

/**
 * Players the scorer can name game captain: the filled boxes without an
 * error (so never a libero, a duplicate, a disqualified player or a number
 * missing from the roster), minus the team captain. Sorted by number.
 * Empty when the roster has no team captain.
 *
 * @returns {string[]} shirt numbers
 */
export function gameCaptainOptions({ lineup = [], players = [], events = [], team = null }) {
  const captain = teamCaptainNumber(players)
  if (!captain) return []
  const errors = lineupEntryErrors({ lineup, players, events, team })
  const seen = new Set()
  ;(lineup || []).forEach((v, i) => {
    if (isBlank(v) || errors[i]) return
    const n = String(Number(v))
    if (n !== captain) seen.add(n)
  })
  return [...seen].sort((a, b) => Number(a) - Number(b))
}

/**
 * The choice the modal starts with when it opens on an existing line-up
 * ("Change current lineup"): the acting game captain when the team captain is
 * not among the six, otherwise the remembered one. Only a valid option is
 * returned; '' means nothing chosen.
 */
export function initialGameCaptainChoice({ lineup = [], players = [], events = [], team = null, currentCourtCaptain = null, rememberedCourtCaptain = null }) {
  const options = gameCaptainOptions({ lineup, players, events, team })
  const status = lineupCaptainStatus({ lineup, players })
  const ordered = status === 'onCourt'
    ? [rememberedCourtCaptain]
    : [currentCourtCaptain, rememberedCourtCaptain]
  for (const n of ordered) {
    if (!isBlank(n) && options.includes(String(Number(n)))) return String(Number(n))
  }
  return ''
}

/**
 * What confirming the line-up does with the optional game-captain choice.
 *
 * - nothing chosen (or the choice is no longer a valid option): 'none', so the
 *   scoreboard behaves as before (it asks when the team captain is off court)
 * - team captain NOT among the six: 'designate'. The player is game captain
 *   from the first rally: both match fields are set and a
 *   'court_captain_designation' event is logged, as the scoreboard prompt
 *   does. When that player already is the acting game captain, no second
 *   event is logged.
 * - team captain among the six: 'remember'. Only the remembered field is set,
 *   so the player takes over without a prompt when the team captain leaves
 *   the court.
 *
 * Undo: the line-up event and the designation event carry `undo`
 * ({ previousRememberedCourtCaptain } when the remembered field changes, else
 * {}), so undoing them puts the remembered game captain back too and a line-up
 * entered again with "None" asks again instead of reusing the undone choice.
 *
 * @returns {{ action: 'none'|'designate'|'remember', playerNumber: number|null,
 *   matchUpdate: object, event: object|null, undo: object }}
 *   matchUpdate: fields to write on the match ({} = nothing);
 *   event: payload of the 'court_captain_designation' event to log, or null;
 *   undo: fields to add to the line-up event's payload
 */
export function lineupGameCaptainDecision({ lineup = [], players = [], events = [], team, choice, currentCourtCaptain = null, rememberedCourtCaptain = null }) {
  const none = { action: 'none', playerNumber: null, matchUpdate: {}, event: null, undo: {} }
  if (isBlank(choice)) return none
  const chosen = String(Number(choice))
  if (!gameCaptainOptions({ lineup, players, events, team }).includes(chosen)) return none

  const playerNumber = Number(chosen)
  const fields = courtCaptainFields(team)
  const matchUpdate = {}
  let undo = {}
  if (isBlank(rememberedCourtCaptain) || String(Number(rememberedCourtCaptain)) !== chosen) {
    matchUpdate[fields.remembered] = playerNumber
    undo = { previousRememberedCourtCaptain: isBlank(rememberedCourtCaptain) ? null : rememberedCourtCaptain }
  }

  if (lineupCaptainStatus({ lineup, players }) === 'onCourt') {
    return { action: 'remember', playerNumber, matchUpdate, event: null, undo }
  }

  const alreadyActing = !isBlank(currentCourtCaptain) && String(Number(currentCourtCaptain)) === chosen
  if (alreadyActing) {
    return { action: 'designate', playerNumber, matchUpdate, event: null, undo }
  }
  matchUpdate[fields.court] = playerNumber
  return {
    action: 'designate',
    playerNumber,
    matchUpdate,
    event: {
      team,
      playerNumber,
      previousCourtCaptain: isBlank(currentCourtCaptain) ? null : currentCourtCaptain,
      ...undo,
      fromLineup: true
    },
    undo
  }
}
