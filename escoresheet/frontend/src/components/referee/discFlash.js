// The referee court's flash on a player who just came in.
//
// A substitution flashes the player in (orange, pulsing) for SUB_FLASH_MS, as
// on the scorer's court. A libero replacement (libero in, out or exchange) is
// routine, many times a set: it flashes once, one short pulse of
// LIBERO_FLASH_MS, then the disc is back to its colours ("do not highlight
// the libero switch like a sub, one flash is enough", owner 15.11.2026).
//
// The list: [{ team, playerNumber, timestamp, kind: 'sub' | 'libero' }]

export const SUB_FLASH_MS = 5000
export const LIBERO_FLASH_MS = 1000

export const LIBERO_EVENT_TYPES = ['libero_entry', 'libero_exit', 'libero_exchange']

/**
 * How a disc flashes: false (not at all), true (a substitution: pulsing) or
 * 'once' (a libero replacement: one pulse). A substitution wins over a libero
 * entry for the same player.
 */
export function discFlashOf(list, team, number) {
  let flash = false
  for (const entry of list || []) {
    if (entry.team !== team || String(entry.playerNumber) !== String(number)) continue
    if (entry.kind !== 'libero') return true
    flash = 'once'
  }
  return flash
}

/** The list with the libero flashes taken out (their one pulse is over). */
export function withoutLiberoFlashes(list) {
  return (list || []).filter(entry => entry.kind !== 'libero')
}

/**
 * The libero event a live-state row reports, as a key: the same event read
 * again (the row is written again for other changes, it keeps its last event)
 * flashes no second time. null: the row's last event is no libero replacement.
 */
export function liberoFlashKey(state) {
  if (!state || !LIBERO_EVENT_TYPES.includes(state.last_event_type)) return null
  const playerNumber = state.last_event_data?.liberoNumber || state.last_event_data?.playerIn
  if (!playerNumber) return null
  return [state.last_event_type, state.last_event_team, playerNumber, state.last_event_ts ?? ''].join('|')
}
