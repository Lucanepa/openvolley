/**
 * "Show on a scoreboard" (docs/scoreboard-code-spec.md): the panel's open
 * state, one per tab. The codes themselves live in utils/scoreboardCode.js
 * (scoreboardCodes), the relay is told from there.
 */
import { useSyncExternalStore } from 'react'

// closed, or open for a match ({ matchId, relayKey })
let panel = null
const listeners = new Set()
const emit = () => { for (const fn of listeners) fn() }

/** Open the panel for a match (the Match menu's "Show on a scoreboard"). */
export function openScoreboardCode(match) {
  panel = match || null
  emit()
}
export function closeScoreboardCode() {
  panel = null
  emit()
}

/** The panel's match, or null while it is closed. */
export function useScoreboardCodePanel() {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn) }, () => panel, () => panel)
}

/** What the panel needs from the scoreboard's live data: the Dexie id and the relay's room key (seed key). */
export function scoreboardCodeMatchOf(data) {
  const match = data?.match
  if (!match || match.id == null) return null
  return { matchId: match.id, relayKey: match.seed_key || match.seedKey || null }
}
