// The coach and the captain of each team sign the roster before the match
// (FIVB 5.1.1, 5.2.1). Owner 2026-10-31: they no longer have to before the
// coin toss is confirmed, so they can sign during the warm-up; the scoring
// screen flashes "Missing signature" per team and the first serve of the
// match (Start set in set 1) waits for all four.

import { PRE_MATCH_SIGNATURE_FIELD } from './phoneSignature'

/** The roles that sign a team's roster before the match, in the order shown. */
export const PRE_MATCH_ROLES = Object.freeze(['coach', 'captain'])

/**
 * An official match needs the signatures. A test match fills placeholders at
 * the coin toss and an easy match has no rosters to sign.
 * @param {object|null|undefined} match the match row
 */
export function needsPreMatchSignatures(match) {
  return !!match && match.test !== true && match.easy !== true
}

/**
 * The roles of one team that have not signed yet.
 * @param {object|null|undefined} match the match row
 * @param {'home'|'away'} team
 * @returns {Array<'coach'|'captain'>}
 */
export function missingRolesOf(match, team) {
  return PRE_MATCH_ROLES.filter(role => !match?.[PRE_MATCH_SIGNATURE_FIELD[`${team}-${role}`]])
}

/**
 * What is still to sign, per team, or null when nothing is (or nothing is
 * needed).
 * @param {object|null|undefined} match the match row
 * @returns {{ home: string[], away: string[] } | null}
 */
export function missingPreMatchSignatures(match) {
  if (!needsPreMatchSignatures(match)) return null
  const home = missingRolesOf(match, 'home')
  const away = missingRolesOf(match, 'away')
  return home.length || away.length ? { home, away } : null
}

/**
 * The match has not started: set 1 and no point played in it. Only then do
 * the missing signatures show and hold back the first serve.
 * @param {{ setIndex: number|null|undefined, isFirstRally: boolean }} at
 */
export function beforeFirstServe({ setIndex, isFirstRally }) {
  return setIndex === 1 && !!isFirstRally
}
