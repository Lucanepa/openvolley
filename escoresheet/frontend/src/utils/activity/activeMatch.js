/**
 * The match open in the scorer app. useAutoBackup (App) sets it whenever the
 * open match changes; the activity log keeps it current on writes of another
 * match. Every interaction log entry is tagged with it (setGameContext), so
 * the diagnostic export of a match finds them.
 */
import { setGameContext } from '../comprehensiveLogger'

let active = null
const listeners = new Set()

/** The game number of a local match row (whichever field the screen wrote). */
export const gameNumberOf = (m) => {
  const v = m?.gameNumber ?? m?.game_n ?? m?.gameN ?? null
  return v === '' ? null : v
}

/** @param {object|null} match local match row (or null: no match open) */
export function setActiveMatch(match) {
  const next = match && match.id != null
    ? {
        id: match.id,
        gameN: gameNumberOf(match),
        seedKey: match.seed_key || null,
        test: match.test === true,
        homeTeamId: match.homeTeamId ?? null,
        awayTeamId: match.awayTeamId ?? null
      }
    : null
  const same = next && active && ['id', 'gameN', 'seedKey', 'test', 'homeTeamId', 'awayTeamId'].every(k => next[k] === active[k])
  if (same || (!next && !active)) return
  active = next
  try {
    setGameContext(next ? next.gameN : null, next ? next.id : null)
  } catch { /* logging must never break the app */ }
  for (const fn of listeners) {
    try { fn(active) } catch { /* ignore */ }
  }
}

export const getActiveMatch = () => active

export function onActiveMatchChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
