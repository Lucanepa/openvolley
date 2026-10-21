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
