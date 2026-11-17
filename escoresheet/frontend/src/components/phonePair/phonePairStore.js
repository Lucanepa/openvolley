/**
 * Pair a phone: one pairing per tab (docs/phone-keyboard-spec.md 5). The
 * controller (utils/phonePair/controller.js) lives for the whole app, so the
 * phone keeps typing across screens (scoreboard, match setup, match end);
 * the panel (pair, show the code, unpair) opens from the scorer's Match menu.
 */
import { useSyncExternalStore } from 'react'
import { createPhonePairController } from '../../utils/phonePair/controller'

let controller = null
export function phonePairController() {
  if (!controller) controller = createPhonePairController()
  return controller
}

// The panel: closed, or open for a match ({ matchId, matchKey, gamePin, context })
let panel = null
const panelListeners = new Set()
const emitPanel = () => { for (const fn of panelListeners) fn() }

/** Open the pairing panel for a match (the Match menu's "Pair a phone"). */
export function openPhonePair(match) {
  panel = match || null
  emitPanel()
}
export function closePhonePairPanel() {
  panel = null
  emitPanel()
}

/** The pairing's state (status, phoneConnected, handle, ...). */
export function usePhonePairState() {
  const c = phonePairController()
  return useSyncExternalStore(c.subscribe, c.getState, c.getState)
}

/** The panel's match, or null when it is closed. */
export function usePhonePairPanel() {
  return useSyncExternalStore((fn) => { panelListeners.add(fn); return () => panelListeners.delete(fn) }, () => panel, () => panel)
}

/**
 * What a pairing of this match needs from the scoreboard's live data: the
 * room key the relays know (seed key), the game PIN (LAN start from another
 * machine), and the context the phone page shows.
 */
export function phonePairMatchOf(data, { lang = 'en', fallbackHome = 'Home', fallbackAway = 'Away' } = {}) {
  const match = data?.match
  if (!match) return null
  const name = (team, fallback) => String(team?.name || team?.shortName || fallback).slice(0, 60)
  const context = { home: name(data.homeTeam, fallbackHome), away: name(data.awayTeam, fallbackAway), lang }
  const no = match.game_n ?? match.gameNumber ?? match.externalId ?? null
  if (no != null && String(no).trim()) context.matchNo = String(no).trim().slice(0, 20)
  return { matchId: match.id ?? null, matchKey: match.seed_key || match.seedKey || null, gamePin: match.gamePin || null, context }
}
