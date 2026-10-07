/**
 * Live state of the Rosters dialog (court position, sanctions, can't-play
 * marks, game captain) derived from the match events and the current lineup.
 * Pure: no React, no Dexie, no writes. The Scoreboard passes in what it has
 * already derived (the current lineup per team from getTeamLineupState).
 */

export const COURT_POSITIONS = ['I', 'II', 'III', 'IV', 'V', 'VI']

/** Sanctions given to one person (player or bench official). */
export const PERSONAL_SANCTIONS = ['warning', 'penalty', 'expulsion', 'disqualification']
/** Sanctions given to the team as a whole (Rule 15.11 + 16). */
export const TEAM_SANCTIONS = ['improper_request', 'delay_warning', 'delay_penalty']

const str = v => (v === undefined || v === null ? '' : String(v))

const tsOf = e => (typeof e?.ts === 'number' ? e.ts : new Date(e?.ts || 0).getTime() || 0)

/** Event order inside a set: seq first (sub-events carry decimals), else time. */
export function compareEvents(a, b) {
  const aSeq = a?.seq || 0
  const bSeq = b?.seq || 0
  if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq
  return tsOf(a) - tsOf(b)
}

/**
 * Court position of every player in a lineup, keyed by jersey number.
 * @param {Record<string, number|string>|null} lineup e.g. { I: 7, II: 3, ... }
 * @returns {Record<string, 'I'|'II'|'III'|'IV'|'V'|'VI'>}
 */
export function positionsByNumber(lineup) {
  const out = {}
  if (!lineup) return out
  for (const pos of COURT_POSITIONS) {
    const n = str(lineup[pos])
    if (n !== '') out[n] = pos
  }
  return out
}

/** True when a lineup has at least one player on court. */
export function hasLineup(lineup) {
  return Object.keys(positionsByNumber(lineup)).length > 0
}

/**
 * Score of the set when `event` happened: points of that set logged before it.
 * @returns {{ home: number, away: number }}
 */
export function scoreAtEvent(events, event) {
  const score = { home: 0, away: 0 }
  if (!event) return score
  const setIndex = event.setIndex || 1
  for (const e of events || []) {
    if (e.type !== 'point' || (e.setIndex || 1) !== setIndex) continue
    if (compareEvents(e, event) >= 0) continue
    if (e.payload?.team === 'home') score.home++
    else if (e.payload?.team === 'away') score.away++
  }
  return score
}

/**
 * Every sanction of one team in the match, split by who received it, in the
 * order they were given. Each entry: { id, type, setIndex, own, opp } where
 * own:opp is the set score with the sanctioned team first.
 * @returns {{ players: Record<string, Array>, officials: Record<string, Array>, team: Array }}
 */
export function teamSanctionSummary(events, teamKey) {
  const out = { players: {}, officials: {}, team: [] }
  const list = (events || [])
    .filter(e => e.type === 'sanction' && e.payload?.team === teamKey)
    .sort((a, b) => ((a.setIndex || 1) - (b.setIndex || 1)) || compareEvents(a, b))
  for (const e of list) {
    const type = e.payload?.type || e.payload?.sanctionType
    if (!type) continue
    const score = scoreAtEvent(events, e)
    const entry = {
      id: e.id ?? `${e.setIndex}-${e.seq}`,
      type,
      setIndex: e.setIndex || 1,
      own: teamKey === 'home' ? score.home : score.away,
      opp: teamKey === 'home' ? score.away : score.home
    }
    const num = str(e.payload?.playerNumber)
    const role = e.payload?.role
    if (TEAM_SANCTIONS.includes(type) || !PERSONAL_SANCTIONS.includes(type)) {
      out.team.push(entry)
    } else if (num !== '') {
      ;(out.players[num] ||= []).push(entry)
    } else if (role) {
      ;(out.officials[role] ||= []).push(entry)
    } else {
      out.team.push(entry)
    }
  }
  return out
}

const isInjurySub = e =>
  e.payload?.isInjury === true || /due to injury/i.test(e.payload?.autoRemark || '')

/**
 * Why a player cannot play right now, if anything, plus whether they were
 * injured during the match (the Rosters dialog marks both).
 *  - 'disqualified': disqualification (any set) - out for the match
 *  - 'expelled'    : expulsion in the current set - out for this set
 *  - 'exceptional' : exceptionally substituted - out for the match
 *  - 'unable'      : libero declared unable / re-designated away
 * @returns {{ out: null|'disqualified'|'expelled'|'exceptional'|'unable', injured: boolean }}
 */
export function playerPlayStatus(events, teamKey, player, currentSetIndex) {
  const num = str(player?.number)
  const status = { out: null, injured: false }
  if (num === '') return status
  const mine = (events || []).filter(e => e.payload?.team === teamKey)
  const sanctioned = type => mine.filter(e =>
    e.type === 'sanction' && e.payload?.type === type && str(e.payload?.playerNumber) === num)
  const subsOut = mine.filter(e => e.type === 'substitution' && str(e.payload?.playerOut) === num)

  if (sanctioned('disqualification').length || subsOut.some(e => e.payload?.isDisqualified === true)) {
    status.out = 'disqualified'
  } else if (
    sanctioned('expulsion').some(e => (e.setIndex || 1) === currentSetIndex) ||
    subsOut.some(e => e.payload?.isExpelled === true && (e.setIndex || 1) === currentSetIndex)
  ) {
    status.out = 'expelled'
  } else if (subsOut.some(e => e.payload?.isExceptional === true)) {
    status.out = 'exceptional'
  } else if (
    player?.libero === 'unable' ||
    mine.some(e => e.type === 'libero_unable' && str(e.payload?.liberoNumber) === num)
  ) {
    status.out = 'unable'
  }

  status.injured =
    subsOut.some(isInjurySub) ||
    mine.some(e => e.type === 'bench_injury' && str(e.payload?.playerNumber) === num) ||
    mine.some(e => e.type === 'libero_unable' && e.payload?.reason === 'injury' && str(e.payload?.liberoNumber) === num)
  return status
}

/**
 * Number of the game captain (court captain) on court, when the team captain
 * is not on court and one was designated - the rule the court discs use.
 * @returns {string|null}
 */
export function gameCaptainOnCourt(players, lineup, courtCaptainNumber) {
  const onCourt = positionsByNumber(lineup)
  const cc = str(courtCaptainNumber)
  if (cc === '' || !onCourt[cc]) return null
  const captain = (players || []).find(p => p.isCaptain || p.captain)
  if (captain && onCourt[str(captain.number)]) return null
  return cc
}
