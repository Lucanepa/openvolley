/**
 * The libero dropdowns of the roster editors: Match setup (the add row and
 * every player row of both teams), the coin toss roster dialog and the
 * in-match roster editor (ReopenRosterModal). One helper, so they cannot
 * drift. Pure: no React, no Dexie.
 *
 * Owner 27.11.2026: "it is either nothing, Libero 1, Libero 2. one libero ->
 * only Libero 1". A team's liberos are 'libero1' (L1) and 'libero2' (L2);
 * L1 comes first:
 *   - L1 is offered while no OTHER player of the team is L1;
 *   - L2 only once ANOTHER player is L1 and no other player is L2;
 *   - a row keeps its own value selectable (an L2 left without its L1 in a
 *     running match, a re-designated or unable libero), so a select never
 *     changes a value silently.
 * A team's only libero is L1 (owner 27.11.2026): when the L1 is deleted or
 * set to none and an L2 is left, the L2 becomes L1 (withLoneLiberoAsL1).
 * Match setup and the coin toss do that at once (no match record yet); the
 * in-match editor only while no recorded event refers to the team's liberos
 * (liberosInRecord), as the record names them by L1 / L2 (liberoType).
 * Legacy rows carry `libero: true`: read as L1.
 */

import { referencedPlayerNumbers } from './roster'

/** A player's libero value as a select shows it ('' for none; legacy true = 'libero1'). */
export function liberoValueOf(player) {
  const v = player?.libero
  if (v === true) return 'libero1'
  return typeof v === 'string' ? v : ''
}

/**
 * The values a libero select offers, in order: '' (no libero), then
 * 'libero1' and 'libero2' where allowed, then the row's own other value
 * ('redesignated' / 'unable' in a running match).
 * @param {Array<{libero?: string|boolean}>} players the team's roster
 * @param {number|null} [rowIndex] the row's index in players; null for a new player (an add row)
 * @param {string|boolean} [own] the row's current value; by default players[rowIndex]'s ('' for an add row)
 * @returns {string[]}
 */
export function liberoChoices(players, rowIndex = null, own) {
  const list = Array.isArray(players) ? players : []
  const current = own === undefined
    ? (rowIndex == null ? '' : liberoValueOf(list[rowIndex]))
    : liberoValueOf({ libero: own })
  const others = list.filter((_, i) => i !== rowIndex)
  const otherL1 = others.some(p => liberoValueOf(p) === 'libero1')
  const otherL2 = others.some(p => liberoValueOf(p) === 'libero2')
  const values = ['']
  if (!otherL1 || current === 'libero1') values.push('libero1')
  if ((otherL1 && !otherL2) || current === 'libero2') values.push('libero2')
  if (current && !values.includes(current)) values.push(current)
  return values
}

/**
 * The libero value a new player gets from an add row's pending choice: the
 * choice while the roster still offers it, else the slot it offers now (an
 * L1 picked while another row became L1 is added as L2), else none (two
 * liberos already).
 * @param {Array} players the roster the player joins
 * @param {string|boolean} pending the add row's value
 */
export function newPlayerLibero(players, pending) {
  const value = liberoValueOf({ libero: pending })
  if (!value) return ''
  const allowed = liberoChoices(players, null)
  if (allowed.includes(value)) return value
  return allowed.find(v => v === 'libero1' || v === 'libero2') || ''
}

/**
 * A team's only libero is L1: with no L1 on the roster, its (first) L2
 * becomes L1. The same array when nothing changes.
 * @template T
 * @param {T[]} players
 * @returns {T[]}
 */
export function withLoneLiberoAsL1(players) {
  const list = Array.isArray(players) ? players : []
  if (list.some(p => liberoValueOf(p) === 'libero1')) return list
  const l2 = list.findIndex(p => liberoValueOf(p) === 'libero2')
  if (l2 === -1) return list
  return list.map((p, i) => (i === l2 ? { ...p, libero: 'libero1' } : p))
}

const LIBERO_EVENT = /^libero_/

/**
 * True when the match record already refers to a team's liberos: a libero
 * replacement, exit, exchange, inability, recovery or re-designation of the
 * team, a line-up carrying a libero, an entry that names a libero's L1 / L2
 * (liberoType), or any entry with the number of a player who is one of the
 * team's liberos. The in-match editor then keeps L1 / L2 as they are.
 * @param {Array} events all events of the match
 * @param {'home'|'away'} teamKey
 * @param {Array} players the team's roster as stored (when the editor opened)
 */
export function liberosInRecord(events, teamKey, players) {
  const names = (e) => {
    const p = e?.payload
    if (!p || p.team !== teamKey) return false
    return LIBERO_EVENT.test(e.type || '') ||
      (e.type === 'lineup' && !!p.liberoSubstitution) ||
      p.liberoType != null || p.liberoInType != null
  }
  for (const e of events || []) {
    if (names(e)) return true
    // a decision change keeps the rows it removed, to put them back on undo
    if (e?.type === 'decision_change' && (e.payload?.removedSubEvents || []).some(names)) return true
  }
  const numbers = referencedPlayerNumbers(events, teamKey)
  return (players || []).some(p => liberoValueOf(p) && p.number != null && p.number !== '' && numbers.has(String(p.number)))
}
