import { useSyncExternalStore } from 'react'

/**
 * Swiss (club games, Einsatzliste, cloud account) or Global (any tournament:
 * no sign-in, no game list, teams and players stay on the device). Chosen once
 * per device in a first-open dialog, changed in Options, and locked while a
 * match is on the device (owner 2026-11-14). null = not chosen yet.
 */
const KEY = 'ov-tool-mode'
const EVENT = 'ov-tool-mode'

export function getToolMode() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'global' || v === 'swiss' ? v : null
  } catch { return null }
}

export function setToolMode(mode) {
  if (mode !== 'swiss' && mode !== 'global') return
  try { localStorage.setItem(KEY, mode) } catch { /* private window: lasts until reload */ }
  try { window.dispatchEvent(new Event(EVENT)) } catch { /* no window */ }
}

const subscribe = (cb) => {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb)
  return () => { window.removeEventListener(EVENT, cb); window.removeEventListener('storage', cb) }
}

export function useToolMode() {
  return useSyncExternalStore(subscribe, getToolMode, () => null)
}

/** A match is on the device: the tool cannot change (delete it first). */
export const toolModeLocked = (...currentMatches) => currentMatches.some(Boolean)

/** The mode a match on the device implies, for devices that never chose. */
export const impliedToolMode = (match) => (!match ? null : match.global === true ? 'global' : match.test === true ? null : 'swiss')
