/**
 * Pure rotation + serving-order helpers (FIVB Rules 7.6-7.7, 12) — no React, no
 * Dexie. Consolidates the clockwise rotation used by Scoreboard and adds the
 * serving-order "Kontrolle" the scorer is responsible for (Swiss
 * Schreiberanleitung §4.1).
 *
 * SCOPE NOTE: a real ROTATIONAL fault (a player serving out of turn) or a
 * POSITIONAL/overlap fault is a referee visual call decided on court — this app
 * DERIVES the server from the rotation, so position I is the server by
 * construction and there is no independent "who actually served" signal to detect
 * a fault against. These helpers therefore provide (a) the canonical rotation,
 * (b) the expected server, and (c) a validity check that catches a CORRUPTED
 * rotation (e.g. a duplicate or missing player after a manual edit) — not a live
 * fault detector.
 */

const POSITIONS = ['I', 'II', 'III', 'IV', 'V', 'VI']

/**
 * Rotate a lineup one position clockwise: the player in II moves to I and serves,
 * I wraps to VI. (II→I, III→II, IV→III, V→IV, VI→V, I→VI.)
 * @param {Record<string,string>} lineup positions I..VI -> player number
 * @returns {Record<string,string>|null}
 */
export function rotateLineup(lineup) {
  if (!lineup) return null
  return {
    I: lineup.II || '',
    II: lineup.III || '',
    III: lineup.IV || '',
    IV: lineup.V || '',
    V: lineup.VI || '',
    VI: lineup.I || '',
  }
}

/** The current server = the player in position I. */
export function getServer(lineup) {
  return lineup ? (lineup.I || null) : null
}

/**
 * The expected server after applying `rotations` clockwise rotations to a
 * starting lineup — the serving-order Kontrolle reference.
 * @param {Record<string,string>} startingLineup
 * @param {number} rotations
 */
export function getExpectedServer(startingLineup, rotations = 0) {
  let lu = startingLineup
  for (let i = 0; i < Math.max(0, rotations); i++) lu = rotateLineup(lu)
  return getServer(lu)
}

/**
 * True when a lineup is a valid on-court rotation: all six positions I..VI filled
 * with six DISTINCT player numbers. A false result means the rotation is corrupted
 * (e.g. a manual edit left a duplicate or a gap) and the serving order can't be
 * trusted — the scorer should re-check the line-up.
 */
export function isRotationValid(lineup) {
  if (!lineup) return false
  const players = POSITIONS.map(pos => lineup[pos])
  if (players.some(p => p === undefined || p === null || p === '')) return false
  const distinct = new Set(players.map(p => String(p)))
  return distinct.size === POSITIONS.length
}
