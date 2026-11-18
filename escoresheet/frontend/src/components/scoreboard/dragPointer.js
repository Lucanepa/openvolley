/**
 * Where the finger is during a touch drag on the scoring screen (a bench
 * player dragged onto the court, or the other way). Kept out of the
 * Scoreboard's state: as state, every finger move rendered the whole scoring
 * screen, once a frame. On a small tablet, with a time-out countdown running
 * as well, the drop and its confirmation then came only after the time-out
 * (owner, 17.11.2026). Only the floating disc (DraggedPlayerOverlay) follows
 * it now.
 */
import { useSyncExternalStore } from 'react'

let position = null
const listeners = new Set()

export const dragPointer = {
  /** @returns {{ x: number, y: number } | null} */
  get: () => position,
  /** @param {{ x: number, y: number } | null} next */
  set: (next) => {
    if (next === position) return
    position = next
    listeners.forEach((listener) => listener())
  },
  subscribe: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
}

/** The finger's position during a touch drag (null when none). */
export function useDragPointer () {
  return useSyncExternalStore(dragPointer.subscribe, dragPointer.get, dragPointer.get)
}
