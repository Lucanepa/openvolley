/**
 * Pure match-end rules — no React, no Dexie, no I/O.
 *
 * Consolidates the match-end decisions that were re-derived in App.finishSet,
 * Scoreboard (set end, forfeit, stop match), MatchEnd and the reopen paths, each
 * with slightly different rules (winner on a sets tie, which statuses mean "over",
 * which signature fields to clear).
 *
 * FORFEIT (FIVB 2025-2028 Rules 6.4.3, 7.3.1, 15.8): a team declared
 * INCOMPLETE for the SET loses the set; a team in default or INCOMPLETE for the
 * MATCH loses the match. The opponent is given the points (and the sets) needed
 * to win; the forfeiting team keeps the points and sets it already has.
 *  - incomplete for the SET: an injured or expelled player who cannot be
 *    substituted legally or exceptionally (the player may be back next set),
 *    or a disqualified player when the team can still field six next set;
 *  - incomplete for the MATCH / default: the manual "Stop the match" forfeit,
 *    or a team that cannot field six players for the next set.
 * Sets are created lazily in this app, so the sets still needed for a match
 * forfeit must be CREATED, following the same index sequence as a played match
 * (best-of-3 at 1-1 jumps 2 -> 5, see matchFormat.getNextSetIndex).
 *
 * STATUS LIFECYCLE: live -> ended (scoreboard, match over) -> approved (MatchEnd
 * signatures) -> final (closed). Any of the last three means the match is over.
 */
import { setsToWin, getNextSetIndex } from '../utils/matchFormat'
import { isDecidingSet, scoreFromPointEvents } from './rules'

/** Match statuses that mean "no more rallies will be played". */
export const MATCH_OVER_STATUSES = Object.freeze(['ended', 'approved', 'final'])

/** True for ended / approved / final. */
export function isMatchOverStatus(status) {
  return MATCH_OVER_STATUSES.includes(status)
}

/**
 * Post-match signature fields on the match row (MatchEnd signing order). These
 * certify the RESULT, so they must all be cleared when the result is reopened
 * for correction. Pre-match coach/captain signatures (homeCoachSignature, ...)
 * are not included: they certify the roster, which a result correction does
 * not change.
 */
export const POST_MATCH_SIGNATURE_FIELDS = Object.freeze([
  'homePostGameCaptainSignature',
  'awayPostGameCaptainSignature',
  'asstScorerSignature',
  'scorerSignature',
  'ref2Signature',
  'ref1Signature'
])

/** An update object that nulls every post-match signature. */
export function clearedPostMatchSignatures() {
  return Object.fromEntries(POST_MATCH_SIGNATURE_FIELDS.map(f => [f, null]))
}

const otherTeam = (teamKey) => (teamKey === 'home' ? 'away' : 'home')
const pointsKey = (teamKey) => (teamKey === 'home' ? 'homePoints' : 'awayPoints')

/** Sets won by each team, counting finished sets only. */
export function countSetsWon(sets) {
  let home = 0
  let away = 0
  for (const s of sets || []) {
    if (!s?.finished) continue
    const h = s.homePoints || 0
    const a = s.awayPoints || 0
    if (h > a) home++
    else if (a > h) away++
  }
  return { home, away }
}

/**
 * The match winner, or null when the match is undecided (e.g. stopped for
 * impossibility to resume with no team having reached the sets needed).
 * @param {Array} sets set rows ({index, homePoints, awayPoints, finished})
 * @param {number} [bestOf=5]
 * @param {{forfeitTeam?: 'home'|'away'|null}} [opts] team that forfeited, if any
 * @returns {'home'|'away'|null}
 */
export function getMatchWinner(sets, bestOf = 5, { forfeitTeam = null } = {}) {
  if (forfeitTeam === 'home' || forfeitTeam === 'away') return otherTeam(forfeitTeam)
  const { home, away } = countSetsWon(sets)
  const needed = setsToWin(bestOf)
  if (home >= needed && home > away) return 'home'
  if (away >= needed && away > home) return 'away'
  return null
}

/**
 * The set played before `currentIndex`: the highest-index set below it. Works
 * for the best-of-3 decider (index 5 follows index 2) where `index - 1` does not.
 * @returns {object|null}
 */
export function findPreviousSet(sets, currentIndex) {
  let prev = null
  for (const s of sets || []) {
    if (s.index < currentIndex && (!prev || s.index > prev.index)) prev = s
  }
  return prev
}

/**
 * Points the opponent of a forfeiting team must reach to win a set: the set
 * target (25, or 15 in the deciding set) with a 2-point lead over the
 * forfeiting team, never fewer than it already has.
 */
export function forfeitSetPoints(forfeitingTeamPoints, opponentPoints, setIndex) {
  const target = isDecidingSet(setIndex) ? 15 : 25
  return Math.max(target, (forfeitingTeamPoints || 0) + 2, opponentPoints || 0)
}

/**
 * Plan the set rows a forfeit writes.
 * @param {object} args
 * @param {Array} args.sets all set rows of the match
 * @param {'home'|'away'} args.forfeitingTeam
 * @param {number} args.currentSetIndex index of the set in progress
 * @param {number} [args.bestOf=5]
 * @param {boolean} [args.setOnly=false] incomplete for the set only: award the
 *   set in progress and nothing else
 * @returns {{winner:'home'|'away', sets:Array<{index:number, id:any, homePoints:number,
 *   awayPoints:number, awardedPoints:number, isCurrent:boolean}>}}
 *   `id` is the existing row id or null for a set that must be created;
 *   `awardedPoints` is how many points the opponent gains in that set.
 */
export function planForfeit({ sets, forfeitingTeam, currentSetIndex, bestOf = 5, setOnly = false }) {
  const opponent = otherTeam(forfeitingTeam)
  const needed = setsToWin(bestOf)
  const byIndex = new Map((sets || []).map(s => [s.index, s]))
  const won = countSetsWon(sets)
  const planned = []

  const award = (index, existing, isCurrent) => {
    const teamPts = existing ? (existing[pointsKey(forfeitingTeam)] || 0) : 0
    const oppBefore = existing ? (existing[pointsKey(opponent)] || 0) : 0
    const oppPts = forfeitSetPoints(teamPts, oppBefore, index)
    planned.push({
      index,
      id: existing?.id ?? null,
      [pointsKey(forfeitingTeam)]: teamPts,
      [pointsKey(opponent)]: oppPts,
      awardedPoints: oppPts - oppBefore,
      isCurrent
    })
    won[opponent]++
  }

  let lastIndex = currentSetIndex
  const current = byIndex.get(currentSetIndex)
  if (setOnly) {
    // Incomplete for the SET only: the opponent wins the set in progress and
    // the match goes on (the set-end path decides whether it is over).
    if (current && !current.finished) award(currentSetIndex, current, true)
    return { winner: opponent, sets: planned }
  }
  if (current && !current.finished && won[opponent] < needed) {
    award(currentSetIndex, current, true)
  } else if (!current || current.finished) {
    // No set in progress: continue after the last finished set.
    const finished = (sets || []).filter(s => s.finished)
    lastIndex = finished.length ? Math.max(...finished.map(s => s.index)) : 0
  }

  while (won[opponent] < needed) {
    const next = lastIndex === 0 ? 1 : getNextSetIndex(lastIndex, won.home, won.away, bestOf)
    if (next > 5) break // defensive: never plan beyond the deciding set
    const existing = byIndex.get(next)
    if (existing?.finished) { lastIndex = next; continue }
    award(next, existing, false)
    lastIndex = next
  }

  return { winner: opponent, sets: planned }
}

const isLiberoPlayer = (p) => !!p?.libero && p.libero !== ''

/**
 * Players of a team who may still take part in the NEXT set: non-liberos who
 * are not disqualified and were not taken out by an exceptional substitution
 * or a disqualification substitution (FIVB 15.7, 15.8 — they cannot re-enter
 * for the rest of the match). Expelled players are back next set, so they
 * count.
 * @param {Array} players the team roster
 * @param {Array} events
 * @param {'home'|'away'} teamKey
 * @param {{exclude?: Array}} [opts] numbers to treat as out as well (e.g. a
 *   player being disqualified right now, before the sanction is logged)
 * @returns {Array} the eligible players
 */
export function playersAvailableForNextSet(players, events, teamKey, { exclude = [] } = {}) {
  const out = new Set((exclude || []).map(String))
  for (const e of events || []) {
    const p = e.payload
    if (!p || p.team !== teamKey) continue
    if (e.type === 'sanction' && p.type === 'disqualification' && p.playerNumber != null &&
      (p.playerType === undefined || p.playerType === 'player')) {
      out.add(String(p.playerNumber))
    }
    if (e.type === 'substitution' && (p.isExceptional || p.isDisqualified) && p.playerOut != null) {
      out.add(String(p.playerOut))
    }
  }
  return (players || []).filter(p => !isLiberoPlayer(p) && !out.has(String(p.number)))
}

/**
 * Whether a forfeit ends the set or the match (see the header).
 * @param {'forfeit'|'injury'|'expulsion'|'disqualification'|string} reason
 *   'forfeit' is the manual "Stop the match" forfeit (default / match)
 * @param {{playersAvailableNextSet?: number}} [opts]
 * @returns {'set'|'match'}
 */
export function forfeitScope(reason, { playersAvailableNextSet = Infinity } = {}) {
  if (reason === 'forfeit') return 'match'
  return playersAvailableNextSet < 6 ? 'match' : 'set'
}

/**
 * Plan the reversal of a forfeit when its set is reopened for correction.
 * A forfeit tags what it writes: awarded point events carry
 * payload.forfeitAwarded, set rows it created carry forfeitCreated, its
 * set_end events have payload.reason 'forfait', and the 'forfait' event keeps
 * payload.setsBefore (the score of the sets it touched, before the forfeit).
 *
 * Everything the forfeit wrote at or after `fromSetIndex` is removed; a set
 * it finished but did not create goes back to unfinished with its pre-forfeit
 * score (from setsBefore, else counted from the remaining point events).
 * @param {object} args
 * @param {Array} args.events all events of the match
 * @param {Array} args.sets all set rows of the match
 * @param {number} [args.fromSetIndex] only reverse forfeit artefacts in this
 *   set or later (default: all)
 * @returns {{hasForfeit:boolean, deleteEventIds:Array, deleteSetIds:Array,
 *   restoreSets:Array<{id:any, index:number, homePoints:number, awayPoints:number}>,
 *   reopenSetIndex:number|null}}
 */
export function planForfeitReversal({ events, sets, fromSetIndex = -Infinity }) {
  const allEvents = events || []
  const allSets = sets || []
  const inScope = (idx) => (idx ?? 0) >= fromSetIndex

  const createdSets = allSets.filter(s => s.forfeitCreated && inScope(s.index))
  const createdIdx = new Set(createdSets.map(s => s.index))

  const isForfeitArtefact = (e) =>
    e.type === 'forfait' ||
    (e.type === 'point' && e.payload?.forfeitAwarded === true) ||
    (e.type === 'set_end' && e.payload?.reason === 'forfait')
  const removed = allEvents.filter(e =>
    inScope(e.setIndex) && (isForfeitArtefact(e) || createdIdx.has(e.setIndex))
  )
  const removedIds = new Set(removed.map(e => e.id))
  const remaining = allEvents.filter(e => !removedIds.has(e.id))

  const setsBefore = new Map()
  for (const e of removed) {
    if (e.type !== 'forfait') continue
    for (const b of e.payload?.setsBefore || []) setsBefore.set(b.index, b)
  }

  // Sets the forfeit finished (or scored in) but did not create
  const touchedIdx = new Set(
    removed
      .filter(e => e.type !== 'forfait' && !createdIdx.has(e.setIndex))
      .map(e => e.setIndex)
  )
  const restoreSets = allSets
    .filter(s => touchedIdx.has(s.index) && !s.forfeitCreated)
    .sort((a, b) => a.index - b.index)
    .map(s => {
      const before = setsBefore.get(s.index)
      const score = before
        ? { homePoints: before.homePoints || 0, awayPoints: before.awayPoints || 0 }
        : scoreFromPointEvents(remaining, s.index)
      return { id: s.id, index: s.index, ...score }
    })

  return {
    hasForfeit: removed.length > 0 || createdSets.length > 0,
    deleteEventIds: removed.map(e => e.id),
    deleteSetIds: createdSets.map(s => s.id),
    restoreSets,
    reopenSetIndex: restoreSets.length > 0 ? restoreSets[0].index : null
  }
}
