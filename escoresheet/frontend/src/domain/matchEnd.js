/**
 * Pure match-end rules — no React, no Dexie, no I/O.
 *
 * Consolidates the match-end decisions that were re-derived in App.finishSet,
 * Scoreboard (set end, forfeit, stop match), MatchEnd and the reopen paths, each
 * with slightly different rules (winner on a sets tie, which statuses mean "over",
 * which signature fields to clear).
 *
 * FORFEIT (FIVB 2025-2028 Rules 6.4, 7.3.1, 15.8):
 *  - DEFAULT (6.4.1-2): a team that refuses to play after being summoned, or
 *    does not appear on time, loses the match 0:3 (best of 3: 0:2) with 0:25
 *    in every set, the sets already played included (the manual "Stop the
 *    match" > "A team forfeits"). The played sets are rewritten; the forfait
 *    event's setsBefore keeps their score for a reversal.
 *  - INCOMPLETE (6.4.3): a team declared incomplete for the SET loses the
 *    set, for the MATCH the match. The opponent is given the points (and the
 *    sets) needed to win; the incomplete team keeps its points and sets.
 *     - for the SET: an injured or expelled player who cannot be substituted
 *       legally or exceptionally (the player may be back next set), or a
 *       disqualified player when the team can still field six next set;
 *     - for the MATCH: a team that cannot field six players for the next set,
 *       or the manual "Stop the match" > "A team is incomplete".
 * Sets are created lazily in this app, so the sets still needed for a match
 * forfeit must be CREATED, following the same index sequence as a played match
 * (best-of-3 at 1-1 jumps 2 -> 5, see matchFormat.getNextSetIndex).
 *
 * STATUS LIFECYCLE: live -> ended (scoreboard, match over) -> approved (MatchEnd
 * signatures) -> final (closed). Any of the last three means the match is over.
 */
import { setsToWin, getNextSetIndex, isMatchFinished, displaySetNumber } from '../utils/matchFormat'
import { isDecidingSet, scoreFromPointEvents } from './rules'

/** Match statuses that mean "no more rallies will be played". */
export const MATCH_OVER_STATUSES = Object.freeze(['ended', 'approved', 'final'])

/** True for ended / approved / final. */
export function isMatchOverStatus(status) {
  return MATCH_OVER_STATUSES.includes(status)
}

/**
 * Whether a match restored or continued from the cloud opens at its Match
 * End rather than the scoring screen: its finished sets decide it, or its
 * status says it is over (ended: also a match stopped or forfeited without
 * the sets won; approved, final: closed).
 */
export function opensAtMatchEnd({ status, homeSetsWon = 0, awaySetsWon = 0, bestOf = 5 }) {
  return isMatchFinished(homeSetsWon, awaySetsWon, bestOf) || isMatchOverStatus(status)
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

/**
 * An update object that nulls every post-match signature, its "signed on
 * phone" record (match.signatureSources, by Dexie key path), and the local
 * copy of the account approvals (scorer, referees): they certify the result
 * too. The server voids its rows when the reopen reaches it (db/011 trigger).
 */
export function clearedPostMatchSignatures() {
  return {
    ...Object.fromEntries(POST_MATCH_SIGNATURE_FIELDS.map(f => [f, null])),
    ...Object.fromEntries(POST_MATCH_SIGNATURE_FIELDS.map(f => [`signatureSources.${f}`, null])),
    accountApprovals: null
  }
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

/** A possible final score of a set: 25 (15 in the deciding set) with a 2-point lead, or more by exactly 2. */
export function isFinalSetScore(winnerPoints, loserPoints, setIndex) {
  const toWin = isDecidingSet(setIndex) ? 15 : 25
  return (winnerPoints === toWin && loserPoints <= toWin - 2) || (winnerPoints > toWin && winnerPoints - loserPoints === 2)
}

/**
 * What keeps a result from being approved (Match End's "Confirm and
 * approve"), judged on the set rows: they are the result the sheet prints
 * (RESULT, the winner) and the cloud gets (set_results, winner,
 * final_score). A correction can leave a finished set at a score no set ends
 * with (a point given to the other team: 24:19, still finished, counted as
 * won by the leader); and a match over whose valid sets give no team the sets
 * it needs. Issues in domain/recompute's form ({ key, params }, issueText):
 * 'setScoreInvalid' { set, score } and 'matchNotDecided' { n, result }, the
 * scores and the result team A first, as on the sheet. A set the forfeit
 * wrote or created and a forfeited or stopped match follow their own rules
 * (planForfeit, impossibility to resume): no issue.
 * @param {{ sets?: Array, events?: Array, match?: object }} args
 * @returns {Array<{ key: string, params: object }>}
 */
export function resultIssues({ sets = [], events = [], match = {} } = {}) {
  const bestOf = Number(match?.bestOf) === 3 ? 3 : 5
  const teamA = match?.coinTossTeamA === 'away' ? 'away' : 'home'
  const teamB = otherTeam(teamA)
  const forfeitSets = new Set((events || [])
    .filter(e => e?.type === 'set_end' && e.payload?.reason === 'forfait')
    .map(e => e.setIndex))
  const finished = (sets || []).filter(s => s?.finished).sort((a, b) => a.index - b.index)
  const issues = []
  const won = { home: 0, away: 0 }
  for (const s of finished) {
    const pts = { home: s.homePoints || 0, away: s.awayPoints || 0 }
    const leader = pts.home > pts.away ? 'home' : pts.away > pts.home ? 'away' : null
    if (s.forfeitCreated || forfeitSets.has(s.index)) {
      if (leader) won[leader]++
      continue
    }
    if (!leader || !isFinalSetScore(pts[leader], pts[otherTeam(leader)], s.index)) {
      issues.push({ key: 'setScoreInvalid', params: { set: displaySetNumber(s.index, bestOf), score: `${pts[teamA]}:${pts[teamB]}` } })
      continue
    }
    won[leader]++
  }
  const need = setsToWin(bestOf)
  if (isMatchOverStatus(match?.status) && !match?.forfeitTeam && !match?.stoppedReason && finished.length > 0 &&
      won.home < need && won.away < need) {
    issues.push({ key: 'matchNotDecided', params: { n: need, result: `${won[teamA]}:${won[teamB]}` } })
  }
  return issues
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
 * @param {boolean} [args.inDefault=false] the team is in default (6.4.1-2):
 *   0:25 in every set of the result, the played ones included
 * @returns {{winner:'home'|'away', sets:Array<{index:number, id:any, homePoints:number,
 *   awayPoints:number, awardedPoints:number, isCurrent:boolean, wasFinished?:boolean,
 *   voided?:boolean}>}}
 *   `id` is the existing row id or null for a set that must be created;
 *   `awardedPoints` is how many points the opponent gains in that set (point
 *   events to log; none in a default: its result is declared, not played).
 *   In a default, `wasFinished` marks a played set that is rewritten (it keeps
 *   its end), `voided` a played set past the result (a default at 2:1 or
 *   2:2) that goes back to unfinished, its score kept, so it no longer counts.
 */
export function planForfeit({ sets, forfeitingTeam, currentSetIndex, bestOf = 5, setOnly = false, inDefault = false }) {
  if (inDefault && !setOnly) return planDefault({ sets, forfeitingTeam, currentSetIndex, bestOf })
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

// Default (6.4.1-2): the opponent wins sets 1, 2 (and 3) 25:0, whatever was
// played. The sets of a straight win never include the deciding set, so 25
// in each. A set already played past them no longer counts (see planForfeit).
function planDefault({ sets, forfeitingTeam, currentSetIndex, bestOf }) {
  const opponent = otherTeam(forfeitingTeam)
  const needed = setsToWin(bestOf)
  const byIndex = new Map((sets || []).map(s => [s.index, s]))
  const planned = []
  const resultIndexes = new Set()
  let index = 0
  for (let won = 0; won < needed; won++) {
    index = index === 0 ? 1 : getNextSetIndex(index, opponent === 'home' ? won : 0, opponent === 'away' ? won : 0, bestOf)
    resultIndexes.add(index)
    const existing = byIndex.get(index)
    planned.push({
      index,
      id: existing?.id ?? null,
      [pointsKey(forfeitingTeam)]: 0,
      [pointsKey(opponent)]: 25,
      awardedPoints: 0,
      isCurrent: !!existing && !existing.finished && index === currentSetIndex,
      wasFinished: existing?.finished === true
    })
  }
  for (const s of [...(sets || [])].sort((a, b) => a.index - b.index)) {
    if (resultIndexes.has(s.index) || !s.finished) continue
    planned.push({
      index: s.index,
      id: s.id,
      homePoints: s.homePoints || 0,
      awayPoints: s.awayPoints || 0,
      awardedPoints: 0,
      isCurrent: false,
      wasFinished: true,
      voided: true
    })
  }
  return { winner: opponent, sets: planned }
}

const isLiberoPlayer = (p) => !!p?.libero && p.libero !== ''

// Sanctions of a player (on court, on the bench, a libero), not of a bench
// official; older events have no playerType
const PLAYER_SANCTION_TYPES = new Set([undefined, null, 'player', 'bench', 'libero'])

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
      PLAYER_SANCTION_TYPES.has(p.playerType)) {
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

// Reasons of an incomplete team (6.4.3), as the Scoreboard writes them; an
// older forfait event without inDefault was a default for any other reason
// (the manual forfeit wrote 'forfeit')
const INCOMPLETE_REASONS = new Set(['injury', 'illness', 'expulsion', 'disqualification', 'incomplete'])

/** Whether a forfait event's payload is a default (6.4.1-2), not an incomplete team. */
export function isDefaultForfait(payload) {
  if (typeof payload?.inDefault === 'boolean') return payload.inDefault
  return !INCOMPLETE_REASONS.has(String(payload?.reason ?? '').trim().toLowerCase())
}

/**
 * The match forfeit recorded in the events (a 'forfait' event not of scope
 * 'set'; older ones had no scope), the earliest if more. Read from the event
 * log, which every device has: the match row's forfeitTeam and the sets'
 * forfeitCreated stay on the scoring device (a copy continued from the cloud
 * has neither).
 * @returns {{team:'home'|'away', setIndex:number, inDefault:boolean}|null}
 */
export function matchForfeitOf(events) {
  let first = null
  for (const e of events || []) {
    if (e?.type !== 'forfait' || e.payload?.scope === 'set') continue
    if (!first || (e.setIndex ?? 0) < (first.setIndex ?? 0)) first = e
  }
  if (!first) return null
  return {
    team: first.payload?.team === 'away' ? 'away' : 'home',
    setIndex: first.setIndex ?? first.payload?.setIndex ?? null,
    inDefault: isDefaultForfait(first.payload)
  }
}

/**
 * Plan the reversal of a forfeit when its set is reopened for correction.
 * A forfeit tags what it writes: awarded point events carry
 * payload.forfeitAwarded, set rows it created carry forfeitCreated, its
 * set_end events have payload.reason 'forfait', and the 'forfait' event keeps
 * payload.setsBefore (the score of the sets it touched, before the forfeit,
 * with finished and endTime for a set already finished: a default rewrites
 * the played sets). forfeitCreated is not synced: on a copy continued from
 * the cloud a created set is known by its events (a forfeit set_end, no
 * point) and by not being in setsBefore.
 *
 * Everything the forfeit wrote at or after `fromSetIndex` is removed; a set
 * it finished but did not create goes back to unfinished with its pre-forfeit
 * score (from setsBefore, else counted from the remaining point events); a
 * set finished before it gets its score and end back, still finished.
 * @param {object} args
 * @param {Array} args.events all events of the match
 * @param {Array} args.sets all set rows of the match
 * @param {number} [args.fromSetIndex] only reverse forfeit artefacts in this
 *   set or later (default: all)
 * @returns {{hasForfeit:boolean, deleteEventIds:Array, deleteSetIds:Array,
 *   restoreSets:Array<{id:any, index:number, homePoints:number, awayPoints:number,
 *   finished?:true, endTime?:string|null}>, reopenSetIndex:number|null}}
 *   (write a restoreSets entry with restoredSetWrites)
 */
export function planForfeitReversal({ events, sets, fromSetIndex = -Infinity }) {
  const allEvents = events || []
  const allSets = sets || []
  const inScope = (idx) => (idx ?? 0) >= fromSetIndex

  // The sets each forfait in scope touched (setsBefore), by index
  const forfaits = allEvents.filter(e => e.type === 'forfait' && inScope(e.setIndex))
  const listedIdx = new Set(forfaits.flatMap(e => (e.payload?.setsBefore || []).map(b => b.index)))
  const matchForfaitInScope = forfaits.some(e => e.payload?.scope !== 'set')
  const ofSet = (idx) => allEvents.filter(e => e.setIndex === idx)
  // Created by a match forfeit, on a device without the local flag: ended by
  // the forfeit without a single point, and not a set it found (setsBefore)
  const createdByEvents = (s) => matchForfaitInScope && !listedIdx.has(s.index) &&
    ofSet(s.index).some(e => e.type === 'set_end' && e.payload?.reason === 'forfait') &&
    !ofSet(s.index).some(e => e.type === 'point')
  const createdSets = allSets.filter(s => inScope(s.index) && (s.forfeitCreated || createdByEvents(s)))
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

  // Sets the forfeit finished (or scored in) but did not create, and the
  // played sets a default rewrote (in setsBefore, below fromSetIndex too:
  // the default is reversed as a whole with its forfait event)
  const touchedIdx = new Set(
    removed
      .filter(e => e.type !== 'forfait' && !createdIdx.has(e.setIndex))
      .map(e => e.setIndex)
  )
  for (const idx of setsBefore.keys()) if (!createdIdx.has(idx)) touchedIdx.add(idx)
  const restoreSets = allSets
    .filter(s => touchedIdx.has(s.index) && !createdIdx.has(s.index))
    .sort((a, b) => a.index - b.index)
    .map(s => {
      const before = setsBefore.get(s.index)
      const score = before
        ? { homePoints: before.homePoints || 0, awayPoints: before.awayPoints || 0 }
        : scoreFromPointEvents(remaining, s.index)
      const finished = before?.finished === true
        ? { finished: true, endTime: before.endTime ?? s.endTime ?? null }
        : {}
      return { id: s.id, index: s.index, ...score, ...finished }
    })
  const reopened = restoreSets.find(r => r.finished !== true)

  return {
    hasForfeit: removed.length > 0 || createdSets.length > 0,
    deleteEventIds: removed.map(e => e.id),
    deleteSetIds: createdSets.map(s => s.id),
    restoreSets,
    reopenSetIndex: reopened ? reopened.index : null
  }
}

/**
 * The writes of one planForfeitReversal restoreSets entry, on the device
 * (Dexie set row) and in the cloud (set job fields): a set the forfeit
 * finished goes back unfinished, one finished before it (a default rewrote
 * it) gets its score back and stays finished, with its end.
 */
export function restoredSetWrites(r) {
  if (r.finished === true) {
    const end = r.endTime ? { endTime: r.endTime } : {}
    return {
      local: { homePoints: r.homePoints, awayPoints: r.awayPoints, finished: true, ...end },
      cloud: { home_points: r.homePoints, away_points: r.awayPoints, finished: true, ...(r.endTime ? { end_time: r.endTime } : {}) }
    }
  }
  return {
    local: { homePoints: r.homePoints, awayPoints: r.awayPoints, finished: false, endTime: null },
    cloud: { home_points: r.homePoints, away_points: r.awayPoints, finished: false, end_time: null }
  }
}
