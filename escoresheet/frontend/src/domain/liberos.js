/**
 * Pure libero helpers (FIVB 2025-2028 Rule 19) — no React, no Dexie.
 *
 * What the scoreboard records for a libero replacement (FIVB 19.3.2):
 *   libero_entry     { team, position, playerOut, liberoIn }
 *   libero_exchange  { team, position, liberoOut, liberoIn, playerNumber }
 *   lineup sub-event { team, lineup, liberoSubstitution: { position, liberoNumber, playerNumber } }
 * The lineup's liberoSubstitution is carried on by every rotation with the
 * libero's new position, so it is matched by libero NUMBER, never by position.
 */

import { playersAvailableForNextSet } from './matchEnd'
import { sanctionedPlayerNumber } from './sanctions'

const same = (a, b) => a != null && b != null && String(a) === String(b)
const bySeqDesc = (a, b) => (b.seq || 0) - (a.seq || 0)
const asNumber = (n) => (n == null || n === '' ? null : (Number.isNaN(Number(n)) ? n : Number(n)))

/**
 * The player a libero currently on court replaced: the only player who may
 * take the libero's place (FIVB 19.3.2.1), e.g. when the libero is expelled
 * or disqualified (19.4.1, 21.3.2-21.3.3) and must leave the court.
 * @param {Array} events all events of the match
 * @param {'home'|'away'} teamKey
 * @param {number} setIndex
 * @param {number|string} liberoNumber
 * @returns {number|string|null} the replaced player's number, or null when unknown
 */
export function playerReplacedByLibero(events, teamKey, setIndex, liberoNumber) {
  const ofTeam = (events || []).filter(e => e && e.setIndex === setIndex && e.payload?.team === teamKey)

  // The lineup's liberoSubstitution (kept current through rotations and exchanges)
  const lineup = ofTeam
    .filter(e => e.type === 'lineup' && same(e.payload?.liberoSubstitution?.liberoNumber, liberoNumber))
    .sort(bySeqDesc)[0]
  if (lineup && lineup.payload.liberoSubstitution.playerNumber != null) {
    return asNumber(lineup.payload.liberoSubstitution.playerNumber)
  }

  // Older data without it: the libero's latest entry or exchange event
  const replacement = ofTeam
    .filter(e => (e.type === 'libero_entry' || e.type === 'libero_exchange') && same(e.payload?.liberoIn, liberoNumber))
    .sort(bySeqDesc)[0]
  if (!replacement) return null
  const replaced = replacement.type === 'libero_entry' ? replacement.payload.playerOut : replacement.payload.playerNumber
  return asNumber(replaced)
}

/** The event that brings an injured libero back into play (owner 22.11.2026). */
export const LIBERO_RECOVERED = 'libero_recovered'

const seqOf = (e) => Number(e?.seq) || 0

/**
 * True when a libero re-designation replaced this libero (its
 * unableLiberoNumber, or his roster row marked 'unable' by it): he is out for
 * the rest of the match, also when he became unable through an injury (owner
 * decision 22.11.2026: "if the injured libero got re-designated, he can't take
 * part anymore in the game").
 * @param {Array} events
 * @param {'home'|'away'} teamKey
 * @param {number|string} liberoNumber
 * @param {{player?: object|null}} [opts] his roster row
 */
export function liberoReplacedByRedesignation(events, teamKey, liberoNumber, { player = null } = {}) {
  if (player?.libero === 'unable') return true
  return (events || []).some(e => e?.type === 'libero_redesignation' && e.payload?.team === teamKey && same(e.payload?.unableLiberoNumber, liberoNumber))
}

/**
 * Whether a libero may play now, and whether an unable one may come back
 * (FIVB 19.4.2; owner decision 22.11.2026). He is unable when
 *  - a re-designation replaced him: out for the match (replaced);
 *  - disqualified (any set) or expelled in this set (21.3.2-21.3.3);
 *  - declared unable, injured or ill, disqualified, or expelled in this set
 *    (libero_unable) since his latest return (libero_recovered);
 *  - substituted because of an injury since then (older data).
 * mayReturn: unable only because of an injury or illness, and not replaced
 * by a re-designation. As long as no re-designation replaced him, the
 * injured libero may play again; the scorer records it (libero_recovered).
 * A libero declared unable (by the coach or the game captain) stays out.
 * @param {Array} events all events of the match
 * @param {'home'|'away'} teamKey
 * @param {number|string} liberoNumber
 * @param {{setIndex?: number|null, player?: object|null}} [opts] setIndex: the
 *   set being played (expulsions count in it only); player: his roster row
 * @returns {{unable: boolean, mayReturn: boolean, replaced: boolean}}
 */
export function liberoPlayState(events, teamKey, liberoNumber, { setIndex = null, player = null } = {}) {
  const thisSet = (e) => setIndex == null || (e.setIndex ?? 1) === setIndex
  const mine = (events || []).filter(e => e && e.payload?.team === teamKey)
  if (liberoReplacedByRedesignation(mine, teamKey, liberoNumber, { player })) {
    return { unable: true, mayReturn: false, replaced: true }
  }
  // a disqualification (any set) or an expulsion (its set) of him, also one
  // given to him as a team official (a playing coach)
  const sentOff = mine.some(e => e.type === 'sanction' && same(sanctionedPlayerNumber(e.payload), liberoNumber) &&
    (e.payload?.type === 'disqualification' || (e.payload?.type === 'expulsion' && thisSet(e))))
  // what happened since he last came back
  const back = mine
    .filter(e => e.type === LIBERO_RECOVERED && same(e.payload?.liberoNumber, liberoNumber))
    .reduce((max, e) => Math.max(max, seqOf(e)), -Infinity)
  const reasons = []
  for (const e of mine) {
    if (seqOf(e) <= back) continue
    if (e.type === 'libero_unable' && same(e.payload?.liberoNumber, liberoNumber)) {
      const reason = e.payload?.reason || 'declared'
      if (reason === 'expulsion' && !thisSet(e)) continue
      reasons.push(reason)
    } else if (e.type === 'substitution' && same(e.payload?.playerOut, liberoNumber) && e.payload?.isInjury === true) {
      reasons.push('injury')
    }
  }
  const unable = sentOff || reasons.length > 0
  return { unable, mayReturn: unable && !sentOff && reasons.every(r => r === 'injury'), replaced: false }
}

/**
 * The unable libero a re-designation replaces when the team has none left
 * (FIVB 19.4.2.4): of the liberos unable now and not replaced before, one
 * who may not come back anyway (declared unable, disqualified, expelled)
 * before an injured one who may (owner 22.11.2026: the libero a
 * re-designation replaces is out for the match), else the one who became
 * unable last.
 * @param {Array} players the team's roster
 * @param {Array} events all events of the match
 * @param {'home'|'away'} teamKey
 * @param {{setIndex?: number|null}} [opts]
 * @returns {object|null} his roster entry
 */
export function liberoToReplaceByRedesignation(players, events, teamKey, { setIndex = null } = {}) {
  const lastUnableSeq = (number) => (events || [])
    .filter(e => e?.payload?.team === teamKey && (
      (e.type === 'libero_unable' && same(e.payload?.liberoNumber, number)) ||
      (e.type === 'sanction' && same(sanctionedPlayerNumber(e.payload), number) && (e.payload?.type === 'expulsion' || e.payload?.type === 'disqualification'))))
    .reduce((max, e) => Math.max(max, seqOf(e)), -Infinity)
  const candidates = (players || [])
    .filter(p => p?.libero && p.libero !== '' && p.libero !== 'unable')
    .map(p => ({ p, state: liberoPlayState(events, teamKey, p.number, { setIndex, player: p }) }))
    .filter(({ state }) => state.unable && !state.replaced)
  if (candidates.length === 0) return null
  const rank = ({ p, state }) => [state.mayReturn ? 1 : 0, -lastUnableSeq(p.number)]
  candidates.sort((a, b) => {
    const [ra, sa] = rank(a)
    const [rb, sb] = rank(b)
    return ra - rb || sa - sb
  })
  return candidates[0].p
}

/**
 * The players a team may re-designate as its libero once it has no libero
 * left (FIVB 19.4.2.3-19.4.2.4; the scorer's "Libero re-designation" list):
 * roster players who are
 *  - not on court at the moment of the re-designation,
 *  - no libero (original, re-designated or unable) and not re-designated
 *    before, nor the libero who became unable, nor a libero an earlier
 *    re-designation replaced (out for the match),
 *  - still allowed to play in the match: not disqualified and not taken out
 *    by a disqualification substitution or by any exceptional substitution
 *    (FIVB 15.7, 15.8, 21.3.3; owner 22.11.2026), the rule the next set's
 *    line-up follows (playersAvailableForNextSet).
 * A player expelled in the set being played and replaced by a legal
 * substitution stays on the list: he plays again next set (21.3.2) and is
 * not offered as libero before then (whether he may be re-designated during
 * that set is an open owner decision).
 * @param {Array} players the team's roster
 * @param {Array} events all events of the match
 * @param {'home'|'away'} teamKey
 * @param {{onCourt?: Array, unableLiberoNumber?: number|string|null}} [opts]
 *   onCourt: the shirt numbers on court now
 * @returns {Array} the roster entries that may be chosen
 */
export function playersForLiberoRedesignation(players, events, teamKey, { onCourt = [], unableLiberoNumber = null } = {}) {
  const key = (n) => (n == null || n === '' || Number.isNaN(Number(n)) ? null : String(Number(n)))
  const court = new Set((onCourt || []).map(key))
  const redesignated = new Set((events || [])
    .filter(e => e?.type === 'libero_redesignation' && e.payload?.team === teamKey)
    .flatMap(e => [key(e.payload?.newLiberoNumber), key(e.payload?.unableLiberoNumber)]))
  const unable = key(unableLiberoNumber)
  return playersAvailableForNextSet(players, events, teamKey).filter(p => {
    const n = key(p.number)
    return n !== null && !court.has(n) && !redesignated.has(n) && n !== unable
  })
}
