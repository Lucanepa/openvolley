/**
 * Roster rows by shirt number, in an order that holds while the scorer types
 * in them. Sorting on every digit (the coin toss roster) or on leaving the
 * number field (Match Setup) moved the row away from the cursor: typing "1"
 * then "5" took the row to the top and then down the list, and the Tab to its
 * last name landed on another player (seen recording a demo, 2026-10-21).
 * The rows are sorted once focus leaves the list.
 */

const numberOf = (p) => Number(p?.number) || 0

// Players without a number first, as the lists sorted before
export const byNumber = (a, b) => numberOf(a) - numberOf(b)

/** The indices of a roster in number order (stable). */
export function numberOrder(roster) {
  const list = Array.isArray(roster) ? roster : []
  return list.map((_, i) => i).sort((a, b) => byNumber(list[a], list[b]) || a - b)
}

/** The roster sorted by number; the same array when it already is (no state update). */
export function sortedByNumber(roster) {
  const list = Array.isArray(roster) ? roster : []
  const order = numberOrder(list)
  return order.every((idx, i) => idx === i) ? roster : order.map(i => list[i])
}

/**
 * The order to draw the rows in: `frozen` (taken when focus entered the list)
 * while it still covers the roster, else by number.
 */
export function steadyOrder(roster, frozen) {
  const list = Array.isArray(roster) ? roster : []
  if (Array.isArray(frozen) && frozen.length === list.length &&
    new Set(frozen).size === list.length && frozen.every(i => Number.isInteger(i) && i >= 0 && i < list.length)) {
    return frozen
  }
  return numberOrder(list)
}

/** A blur (focusout) whose focus goes outside the element that handles it. */
export const focusLeaves = (e) => !e.currentTarget.contains(e.relatedTarget)

// # / A–Z (owner 2026-11-25, tester: "being able to sort by alphabetical order
// on the list of players"): the rows shown by number, as the roster is kept, or
// A–Z by last name, then first name, then number. The roster array keeps its
// order (rows are edited by their index): displayOrder gives the indices.
/** Where the scorer's choice is kept on this device. */
export const ROSTER_SORT_KEY = 'ov.rosterSort'

/** 'number' (the default) or 'name'. */
export function readRosterSort() {
  try { return localStorage.getItem(ROSTER_SORT_KEY) === 'name' ? 'name' : 'number' } catch { return 'number' }
}

export function saveRosterSort(mode) {
  try { localStorage.setItem(ROSTER_SORT_KEY, mode === 'name' ? 'name' : 'number') } catch { /* private mode: this session only */ }
}

const blank = (v) => v == null || String(v).trim() === ''
const numberOrInf = (p) => (blank(p?.number) ? Infinity : Number(p.number))
const text = (v) => String(v ?? '').trim()

/**
 * @param {Array<{number?: any, lastName?: string, firstName?: string}>} roster
 * @param {'number'|'name'} mode
 * @returns {number[]} the roster's indices in the order to show its rows
 */
export function displayOrder(roster, mode = 'number') {
  const list = Array.isArray(roster) ? roster : []
  const indices = list.map((_, i) => i)
  if (mode !== 'name') return indices
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  return indices.sort((a, b) => {
    const pa = list[a]; const pb = list[b]
    // a row without a name yet (just added) goes last
    const ea = blank(pa?.lastName) && blank(pa?.firstName); const eb = blank(pb?.lastName) && blank(pb?.firstName)
    if (ea !== eb) return ea ? 1 : -1
    return collator.compare(text(pa?.lastName), text(pb?.lastName)) ||
      collator.compare(text(pa?.firstName), text(pb?.firstName)) ||
      numberOrInf(pa) - numberOrInf(pb) || a - b
  })
}
